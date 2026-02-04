const express = require('express')
const cors = require('cors')
const multer = require('multer')
const OpenAI = require('openai')
const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { toFile } = require('openai/uploads')
const axios = require('axios')
const FormData = require('form-data')
const { createDb } = require('./db')
const transactionProcessor = require('./transactionProcessor')
const { parseTaxPdfToText, parseTaxPdfsBatchViaHttp } = require('./taxPdfParser')
const { USE_FINANCIAL_PDF_SERVICE, analyzeFinancialPdfsViaPdftopng } = require('./financialPdfService')
try { require('dotenv').config({ path: '.env.local' }) } catch {}
require('dotenv').config()

// Настройка multer для загрузки файлов
const upload = multer({ 
  storage: multer.memoryStorage(),
  // Лимит для PDF файлов (выписки, налоговая и финансовая отчетность)
  // 50MB на один файл, максимум 50 файлов за один запрос
  limits: { 
    fileSize: 50 * 1024 * 1024,
    files: 50
  },
  // Игнорируем неожиданные поля (например, дополнительные поля от фронтенда)
  fileFilter: (req, file, cb) => {
    // Принимаем все файлы, которые приходят в поле 'files'
    cb(null, true)
  }
})

const MOJIBAKE_PATTERN = /[ÃÂÐÑ]/ // Распространенные символы "битой" кириллицы

const normalizeFileName = (name = '') => {
  if (!name) return ''
  const trimmed = String(name).trim()
  if (!trimmed) return ''
  if (!MOJIBAKE_PATTERN.test(trimmed)) {
    return trimmed
  }
  try {
    return Buffer.from(trimmed, 'latin1').toString('utf8')
  } catch {
    return trimmed
  }
}

const prepareUploadedFiles = (files = []) => {
  const timestamp = Date.now()
  files.forEach((file, index) => {
    const fallbackName = file?.originalname || file?.originalName || `file_${timestamp}_${index}`
    const normalized = normalizeFileName(fallbackName) || fallbackName
    file.originalname = normalized
    file.originalName = normalized
  })
  return files
}

console.log('Loading Agents SDK...')
const { Agent, Runner, MCPServerStdio } = require('@openai/agents')
const { z } = require('zod')
console.log('Agents SDK loaded successfully')

const app = express()

const resumePendingAnalyses = async () => {
  try {
    const pendingReports = await db.prepare(`
      SELECT session_id
      FROM reports
      WHERE status = 'generating'
      ORDER BY created_at ASC
    `).all()
    
    const pendingTax = await db.prepare(`
      SELECT session_id
      FROM reports
      WHERE tax_status = 'generating'
      ORDER BY created_at ASC
    `).all()
    
    const pendingFs = await db.prepare(`
      SELECT session_id
      FROM reports
      WHERE fs_status = 'generating'
      ORDER BY created_at ASC
    `).all()
    
    const uniqueSessions = new Set([
      ...pendingReports.map(r => r.session_id),
      ...pendingTax.map(r => r.session_id),
      ...pendingFs.map(r => r.session_id),
    ])
    
    if (!uniqueSessions.size) {
      console.log('✅ Нет незавершённых анализов для восстановления')
      return
    }
    
    console.log(`⚙️ Восстанавливаем анализ для ${uniqueSessions.size} сессий:`, Array.from(uniqueSessions))
    
    for (const sessionId of uniqueSessions) {
      try {
        const report = await db.prepare('SELECT * FROM reports WHERE session_id = ?').get(sessionId)
        if (!report) continue
        
        if (report.status === 'generating') {
          console.log(`🔁 Перезапускаем анализ банковских выписок для ${sessionId}`)
          runStatementsAnalysis(sessionId)
        }
        
        if (report.tax_status === 'generating') {
          console.log(`🔁 Перезапускаем налоговый анализ для ${sessionId}`)
          runTaxAnalysis(sessionId)
        }
        
        if (report.fs_status === 'generating') {
          console.log(`🔁 Перезапускаем анализ фин. отчётности для ${sessionId}`)
          runFsAnalysis(sessionId)
        }
      } catch (resumeError) {
        console.error(`⚠️ Не удалось восстановить анализ для ${sessionId}:`, resumeError.message)
      }
    }
  } catch (error) {
    console.error('❌ Ошибка восстановления незавершённых анализов:', error)
  }
}

// Настройка CORS для GitHub Pages
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8787',
  'https://mshaim001-hue.github.io',
  process.env.FRONTEND_URL
].filter(Boolean)

// Паттерны для GitHub Pages
const githubPagesPattern = /^https:\/\/.*\.github\.io$/
const githubPagesPatternAlt = /^https:\/\/.*\.githubpages\.io$/

app.use(cors({
  origin: function (origin, callback) {
    // Разрешаем запросы без origin (например, Postman, curl)
    if (!origin) {
      console.log('🌐 CORS: Request without origin (allowed)')
      return callback(null, true)
    }
    
    // Проверяем точное совпадение с разрешенными источниками
    const exactMatch = allowedOrigins.includes(origin)
    
    // Проверяем паттерны GitHub Pages
    const isGitHubPages = githubPagesPattern.test(origin) || githubPagesPatternAlt.test(origin)
    
    if (exactMatch || isGitHubPages) {
      console.log('✅ CORS: Allowed origin:', origin)
      callback(null, true)
    } else {
      console.log('❌ CORS blocked origin:', origin)
      console.log('✅ Allowed origins:', allowedOrigins)
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
app.use(express.json({ limit: '10mb' }))

// Инициализация MCP сервера со справочной информацией iKapitalist
let ikapInfoMcpServer = null
let tempMcpServerPath = null

// Функция для генерации кода MCP сервера с разделами из БД
const generateMcpServerCode = async () => {
  try {
    // Загружаем разделы из БД
    const sectionsQuery = db.prepare(`
      SELECT section_id, title, content 
      FROM mcp_sections 
      ORDER BY section_id
    `)
    const dbSections = await sectionsQuery.all()
    
    // Загружаем базовый шаблон MCP сервера
    const fallbackPath = path.join(__dirname, 'mcp', 'ikap-info-server.js')
    let baseCode = ''
    if (fs.existsSync(fallbackPath)) {
      baseCode = fs.readFileSync(fallbackPath, 'utf8')
    } else {
      throw new Error('Базовый файл MCP сервера не найден')
    }
    
    // Если разделов в БД нет, используем базовый код
    if (dbSections.length === 0) {
      console.log('📄 Разделов в БД нет, используем базовый код')
      return baseCode
    }
    
    // Генерируем объект sections из БД
    const sectionsCode = dbSections
      .map((section) => {
        // Экранируем обратные кавычки и ${ в контенте для template literal
        const escapedContent = section.content
          .replace(/\\/g, '\\\\')
          .replace(/`/g, '\\`')
          .replace(/\${/g, '\\${')
        return `  ${section.section_id}: \`${escapedContent}\``
      })
      .join(',\n')
    
    // Генерируем массив sectionIds
    const sectionIds = dbSections.map(s => s.section_id)
    const sectionIdsCode = sectionIds.map(id => `'${id}'`).join(', ')
    
    // Находим начало и конец объекта sections в базовом коде
    const sectionsStart = baseCode.indexOf('const sections = {')
    const sectionsEnd = baseCode.indexOf('};', sectionsStart) + 2
    
    if (sectionsStart === -1 || sectionsEnd === 1) {
      console.warn('⚠️ Не удалось найти объект sections в базовом коде, используем базовый код')
      return baseCode
    }
    
    // Заменяем объект sections
    const beforeSections = baseCode.substring(0, sectionsStart)
    const afterSections = baseCode.substring(sectionsEnd)
    const newSectionsCode = `const sections = {\n${sectionsCode}\n}`
    
    // Заменяем sectionIds
    const sectionIdsPattern = /const sectionIds = Object\.keys\(sections\)/
    const newSectionIdsCode = `const sectionIds = [${sectionIdsCode}]`
    
    let generatedCode = beforeSections + newSectionsCode + afterSections
    generatedCode = generatedCode.replace(sectionIdsPattern, newSectionIdsCode)
    
    console.log(`✅ Сгенерирован код MCP сервера с ${dbSections.length} разделами из БД`)
    return generatedCode
  } catch (error) {
    console.error('❌ Ошибка генерации кода MCP сервера:', error)
    // В случае ошибки возвращаем базовый код
    const fallbackPath = path.join(__dirname, 'mcp', 'ikap-info-server.js')
    if (fs.existsSync(fallbackPath)) {
      return fs.readFileSync(fallbackPath, 'utf8')
    }
    throw error
  }
}

// Функция для создания MCP сервера из кода в БД
const initMcpServerFromDb = async () => {
  try {
    // Генерируем код MCP сервера с разделами из БД
    let mcpServerCode = await generateMcpServerCode()
    
    // Создаем временный файл из кода в БД
    const tempDir = path.join(__dirname, 'mcp', 'temp')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    tempMcpServerPath = path.join(tempDir, 'ikap-info-server.js')
    fs.writeFileSync(tempMcpServerPath, mcpServerCode, 'utf8')
    console.log(`✅ Временный файл MCP сервера создан: ${tempMcpServerPath}`)
    
    // Получаем годовую ставку по умолчанию из настроек агента
    const settings = await getAgentSettings('Information Agent')
    const defaultAnnualRate = settings?.default_annual_rate || 0.3
    
    // Создаем MCP сервер из временного файла
    ikapInfoMcpServer = new MCPServerStdio({
      command: process.execPath,
      args: [tempMcpServerPath],
      cwd: path.dirname(tempMcpServerPath),
      env: {
        ...process.env,
        DEFAULT_ANNUAL_RATE: String(defaultAnnualRate) // Передаем ставку в MCP сервер
      },
      cacheToolsList: true
    })

    await ikapInfoMcpServer.connect()
    console.log('✅ MCP сервер информации iKapitalist запущен из БД')
    return ikapInfoMcpServer
  } catch (error) {
    console.error('❌ Ошибка инициализации MCP сервера из БД:', error)
    ikapInfoMcpServer = null
    return null
  }
}

// Функция для инициализации базовых разделов MCP
const initDefaultMcpSections = async () => {
  try {
    // Проверяем, есть ли уже разделы в БД
    const countQuery = db.prepare('SELECT COUNT(*) as count FROM mcp_sections')
    const countResult = await countQuery.get()
    const count = countResult?.count || 0
    
    if (count > 0) {
      console.log(`✅ Разделы MCP уже инициализированы (${count} разделов)`)
      return
    }
    
    // Базовые разделы из файла ikap-info-server.js
    const defaultSections = [
      {
        section_id: 'overview',
        title: 'Обзор iKapitalist',
        content: `# Обзор iKapitalist

iKapitalist — лицензированная инвестиционная и заёмная краудфандинговая платформа, работающая с 2019 года.
Платформа помогает малому и среднему бизнесу привлекать финансирование от инвесторов на прозрачных условиях.
Инвесторы могут выдавать займы или покупать доли в компаниях, получая доходность от 24% годовых.

**Ключевые факты:**
- Запуск: 2019 год
- Лицензия AFSA-А-LA-2023-0005 (Астана, МФЦА)
- Управление инвестиционной и заёмной краудфандинговой платформой
- Возможность прямого общения инвесторов с собственниками бизнеса`
      },
      {
        section_id: 'licensing',
        title: 'Лицензирование и регулирование',
        content: `# Лицензирование и регулирование

Платформа iKapitalist.kz зарегистрирована в юрисдикции Международного финансового центра «Астана» (МФЦА) и регулируется Управлением по финансовым услугам AFSA.

**Лицензия:**
- Номер: AFSA-A-LA-2023-0005
- Дата выдачи: 27.04.2023
- Статус: активна
- Деятельность: управление инвестиционной и заёмной краудфандинговой платформой и платформой заемного финансирования`
      },
      {
        section_id: 'contacts',
        title: 'Контакты iKapitalist',
        content: `# Контакты iKapitalist

Адрес: Мангилик Ел, 55/21, блок С4.2, офис 265, Астана, Казахстан
Телефон: +7 700 178 00 18
Электронная почта: claims@ikapitalist.kz

Регулятор AFSA:
- Адрес: ул. Мангилик Ел 55/17, блок C3.2, Астана, Казахстан
- Телефон: +7 (7172) 64 73 71
- Email: apd@afsa.kz`
      }
    ]
    
    const insertSection = db.prepare(`
      INSERT INTO mcp_sections (section_id, title, content)
      VALUES (?, ?, ?)
      ON CONFLICT (section_id) DO NOTHING
    `)
    
    let inserted = 0
    for (const section of defaultSections) {
      try {
        await insertSection.run(section.section_id, section.title, section.content)
        inserted++
      } catch (e) {
        // Игнорируем ошибки при конфликте (раздел уже существует)
      }
    }
    
    if (inserted > 0) {
      console.log(`✅ Инициализировано ${inserted} базовых разделов MCP`)
    }
  } catch (error) {
    console.error('❌ Ошибка инициализации базовых разделов MCP:', error)
  }
}

// Инициализируем MCP сервер асинхронно после инициализации БД
setImmediate(async () => {
  await initDefaultMcpSections()
  await initMcpServerFromDb()
})

process.on('exit', () => {
  if (ikapInfoMcpServer?.close) {
    ikapInfoMcpServer.close().catch((error) => {
      console.error('⚠️ Ошибка закрытия MCP сервера информации:', error)
    })
  }
  // Удаляем временный файл при выходе
  if (tempMcpServerPath && fs.existsSync(tempMcpServerPath)) {
    try {
      fs.unlinkSync(tempMcpServerPath)
      console.log('🗑️ Временный файл MCP сервера удален')
    } catch (e) {
      console.warn('⚠️ Не удалось удалить временный файл:', e.message)
    }
  }
})

// В production отдаем статические файлы после сборки
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../dist')
  // Основной путь (корень домена)
  app.use(express.static(distPath))
  // Дополнительный префикс /ikap для совместимости со старыми билдами (GitHub Pages base)
  app.use('/ikap', express.static(distPath))
}

// Глобальный OpenAI клиент для Assistants API
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Инициализация БД (Postgres/SQLite) и создание схемы
const db = createDb()

async function initSchema() {
  if (db.type === 'pg') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        session_id TEXT UNIQUE NOT NULL,
        company_bin TEXT,
        amount TEXT,
        term TEXT,
        purpose TEXT,
        name TEXT,
        email TEXT,
        phone TEXT,
        report_text TEXT,
        status TEXT DEFAULT 'generating',
        files_count INTEGER DEFAULT 0,
        files_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        message_order INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_id TEXT UNIQUE NOT NULL,
        original_name TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        category TEXT,
        file_path TEXT,
        file_data BYTEA,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
      
      -- Дополнительные поля для отдельных анализов (налоги и фин. отчетность)
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS tax_report_text TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS tax_status TEXT DEFAULT 'pending';
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS tax_missing_periods TEXT;
      
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS fs_report_text TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS fs_report_structured TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS fs_status TEXT DEFAULT 'pending';
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS fs_missing_periods TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS comment TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS openai_response_id TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS openai_status TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_structured TEXT;
      
      -- Добавляем колонку file_path в таблицу files, если её нет
      ALTER TABLE files ADD COLUMN IF NOT EXISTS file_path TEXT;
      -- Добавляем колонку file_data для хранения файлов в БД
      ALTER TABLE files ADD COLUMN IF NOT EXISTS file_data BYTEA;
      
      -- Таблица для хранения настроек агентов
      CREATE TABLE IF NOT EXISTS agent_settings (
        id SERIAL PRIMARY KEY,
        agent_name TEXT UNIQUE NOT NULL,
        instructions TEXT NOT NULL,
        role TEXT,
        functionality TEXT,
        mcp_config JSONB,
        model TEXT DEFAULT 'gpt-5-mini',
        model_settings JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Добавляем колонки role и functionality, если их еще нет
      ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS role TEXT;
      ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS functionality TEXT;
      -- Добавляем колонку для хранения кода MCP сервера
      ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS mcp_server_code TEXT;
      -- Добавляем колонку для годовой ставки по умолчанию
      ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS default_annual_rate NUMERIC DEFAULT 0.3;
      
      -- Создаем индекс для быстрого поиска по agent_name
      CREATE INDEX IF NOT EXISTS idx_agent_settings_name ON agent_settings(agent_name);
      
      -- Таблица для хранения разделов MCP сервера
      CREATE TABLE IF NOT EXISTS mcp_sections (
        id SERIAL PRIMARY KEY,
        section_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_mcp_sections_id ON mcp_sections(section_id);
    `)
    
    // Добавляем UNIQUE constraint на file_id отдельным запросом (если его еще нет)
    try {
      await db.prepare(`
        ALTER TABLE files ADD CONSTRAINT files_file_id_key UNIQUE (file_id)
      `).run()
      console.log('✅ UNIQUE constraint на file_id добавлен')
    } catch (error) {
      // Игнорируем ошибку, если constraint уже существует
      if (error.code === '23505' || error.message?.includes('already exists') || error.message?.includes('duplicate')) {
        console.log('ℹ️ UNIQUE constraint на file_id уже существует')
      } else {
        console.error('⚠️ Ошибка добавления UNIQUE constraint на file_id:', error.message)
      }
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        company_bin TEXT,
        amount TEXT,
        term TEXT,
        purpose TEXT,
        name TEXT,
        email TEXT,
        phone TEXT,
        report_text TEXT,
        status TEXT DEFAULT 'generating',
        files_count INTEGER DEFAULT 0,
        files_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        message_order INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        file_id TEXT UNIQUE NOT NULL,
        original_name TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        category TEXT,
        file_path TEXT,
        file_data BLOB,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
      
      -- Таблица для хранения настроек агентов
      CREATE TABLE IF NOT EXISTS agent_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT UNIQUE NOT NULL,
        instructions TEXT NOT NULL,
        role TEXT,
        functionality TEXT,
        mcp_config TEXT,
        model TEXT DEFAULT 'gpt-5-mini',
        model_settings TEXT,
        mcp_server_code TEXT,
        default_annual_rate REAL DEFAULT 0.3,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_agent_settings_name ON agent_settings(agent_name);
      
      -- Таблица для хранения разделов MCP сервера
      CREATE TABLE IF NOT EXISTS mcp_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        section_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_mcp_sections_id ON mcp_sections(section_id);
      
      -- Добавляем колонки, если их еще нет (для существующих таблиц)
      -- SQLite не поддерживает IF NOT EXISTS для ALTER TABLE, поэтому используем try-catch
    `)
    
    // Для SQLite добавляем колонки отдельно (если таблица уже существует)
    try {
      await db.exec(`
        ALTER TABLE agent_settings ADD COLUMN default_annual_rate REAL DEFAULT 0.3;
      `)
    } catch (e) {
      // Игнорируем ошибку, если колонка уже существует
      if (!e.message?.includes('duplicate column') && !e.message?.includes('already exists')) {
        console.warn('⚠️ Не удалось добавить колонку default_annual_rate:', e.message)
      }
    }
  }
  console.log('✅ Database initialized with all tables')
}

initSchema().catch(e => {
  console.error('❌ DB init failed', e)
})

// Вспомогательные функции для работы с БД
const normalizeMessageRole = (role) => {
  const r = String(role || '').toLowerCase().trim()
  if (r === 'assistant' || r === 'user') return r
  // Частые варианты из разных SDK/логик
  if (r === 'bot') return 'assistant'
  // system/developer/tool сообщения в таблицу messages не пишем (она про диалог user<->assistant)
  return null
}

const saveMessageToDB = async (sessionId, role, content, messageOrder) => {
  try {
    const normalizedRole = normalizeMessageRole(role)
    if (!normalizedRole) {
      // Молча пропускаем невалидные роли, чтобы не засорять логи "undefined"
      return
    }
    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, role, content, message_order)
      VALUES (?, ?, ?, ?)
    `)
    await insertMessage.run(sessionId, normalizedRole, JSON.stringify(content), messageOrder)
    console.log(`💾 Сообщение сохранено в БД: ${normalizedRole} #${messageOrder}`)
  } catch (error) {
    // Если БД недоступна, логируем но продолжаем работу
    if (error.code === 'XX000' || error.message?.includes('db_termination') || error.message?.includes('shutdown')) {
      console.error(`⚠️ БД соединение разорвано при сохранении сообщения. Продолжаем работу без сохранения.`)
    } else {
      console.error(`❌ Ошибка сохранения сообщения в БД:`, error)
    }
    // Не пробрасываем ошибку - работаем без сохранения в БД
  }
}

// Функция для сохранения файла в БД (вместо файловой системы)
const saveFileToDatabase = async (buffer, sessionId, fileId, originalName, mimeType = null) => {
  try {
    // Определяем mime_type по расширению файла, если не передан
    if (!mimeType) {
      mimeType = originalName.toLowerCase().endsWith('.pdf') 
        ? 'application/pdf' 
        : (originalName.toLowerCase().endsWith('.json') 
          ? 'application/json' 
          : 'application/octet-stream')
    }
    
    // Сохраняем файл напрямую в БД
    // PostgreSQL использует ON CONFLICT для обновления при дублировании file_id
    const insertFile = db.prepare(`
      INSERT INTO files (session_id, file_id, original_name, file_size, mime_type, file_data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (file_id) DO UPDATE SET
        file_data = EXCLUDED.file_data,
        file_size = EXCLUDED.file_size,
        mime_type = EXCLUDED.mime_type
    `)
    
    await insertFile.run(
      sessionId, 
      fileId, 
      originalName, 
      buffer.length, 
      mimeType,
      buffer // PostgreSQL BYTEA автоматически обработает Buffer
    )
    
    console.log(`💾 Файл сохранен в БД: ${originalName} (${buffer.length} bytes)`)
    return null // file_path больше не используется
  } catch (error) {
    console.error(`❌ Ошибка сохранения файла в БД:`, error)
    throw error
  }
}

const saveFileToDB = async (sessionId, fileId, originalName, fileSize, mimeType, category, fileData = null) => {
  try {
    // Если fileData передан, сохраняем его в БД
    if (fileData) {
      const insertFile = db.prepare(`
        INSERT INTO files (session_id, file_id, original_name, file_size, mime_type, category, file_data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (file_id) DO UPDATE SET
          file_data = EXCLUDED.file_data,
          file_size = EXCLUDED.file_size,
          category = EXCLUDED.category
      `)
      await insertFile.run(sessionId, fileId, originalName, fileSize, mimeType, category || null, fileData)
    } else {
      // Если fileData не передан, обновляем только метаданные (для обработанных файлов)
      const insertFile = db.prepare(`
        INSERT INTO files (session_id, file_id, original_name, file_size, mime_type, category)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (file_id) DO UPDATE SET
          file_size = EXCLUDED.file_size,
          category = EXCLUDED.category
      `)
      await insertFile.run(sessionId, fileId, originalName, fileSize, mimeType, category || null)
    }
  } catch (error) {
    // Проверяем, это ошибка разрыва соединения с БД
    if (error.code === 'XX000' || error.message?.includes('db_termination') || error.message?.includes('shutdown')) {
      console.error(`❌ БД соединение разорвано при сохранении файла ${originalName}. Переподключаемся...`)
      // Пытаемся переподключиться (БД должна сама переподключиться при следующем запросе)
      throw error // Пробрасываем, чтобы обработчик попытался переподключиться
    }
    console.error(`❌ Ошибка сохранения файла в БД:`, error)
    throw error // Пробрасываем ошибку дальше
  }
}

// Обновление категории уже сохраненного файла (по факту подтверждения от агента)
const updateFileCategoryInDB = async (fileId, category) => {
  try {
    const updateStmt = db.prepare(`
      UPDATE files
      SET category = ?
      WHERE file_id = ?
    `)
    await updateStmt.run(category, fileId)
  } catch (error) {
    // Если БД недоступна, логируем но не падаем
    if (error.code === 'XX000' || error.message?.includes('db_termination') || error.message?.includes('shutdown')) {
      console.error(`⚠️ БД соединение разорвано при обновлении категории файла. Продолжаем работу.`)
    } else {
      console.error(`❌ Ошибка обновления категории файла:`, error)
    }
    // Не пробрасываем ошибку - это некритично
  }
}

// Определение категории файла по названию/типу
const categorizeUploadedFile = (originalName, mimeType) => {
  const name = String(originalName || '').toLowerCase()
  const type = String(mimeType || '').toLowerCase()
  
  // Финансовая отчетность: Excel файлы, изображения, PDF с финансовыми маркерами, ZIP
  const isExcel = type.includes('excel') || type.includes('spreadsheet') || 
                  false // XLSX больше не поддерживается, только PDF
  const isImage = type.includes('image') || name.match(/\.(jpg|jpeg|png|gif|bmp|webp)$/)
  const isZip = type.includes('zip') || name.endsWith('.zip')
  const isFinancialPdf = type.includes('pdf') && 
                         (name.includes('balance') || name.includes('balans') || name.includes('баланс') ||
                          name.includes('profit') || name.includes('pribyl') || name.includes('прибыль') ||
                          name.includes('loss') || name.includes('ubyitok') || name.includes('убыток') ||
                          name.includes('financial') || name.includes('finance') || name.includes('финанс') ||
                          name.includes('oopu') || name.includes('pnl') || name.includes('опу'))
  
  if (isExcel || isImage || isZip || isFinancialPdf) {
    // Финансовая отчетность: принимаем только PDF файлы
    return 'financial'
  }
  
  // Для налогов и выписок - только PDF
  const isPdf = type.includes('pdf') || name.endsWith('.pdf')
  
  if (isPdf) {
    // Определяем категорию по названию файла
    if (name.includes('nalog') || name.includes('налог') || name.includes('tax')) {
      return 'taxes'
    }
    // По умолчанию считаем PDF как банковские выписки
    return 'statements'
  }
  
  // Если формат не поддерживается - вернем null
  return null
}

// Получение прогресса по сессии
const getSessionProgress = async (sessionId) => {
  const rows = await db.prepare(`SELECT category, COUNT(*) as cnt FROM files WHERE session_id = ? GROUP BY category`).all(sessionId)
  const safeRows = Array.isArray(rows) ? rows : []
  if (!Array.isArray(rows)) {
    console.warn('getSessionProgress: unexpected rows', rows)
  }
  const map = Object.fromEntries(safeRows.map(r => [r.category || 'uncategorized', r.cnt]))
  return {
    statements: (map['statements'] || 0) > 0,
    taxes: (map['taxes'] || 0) > 0,
    financial: (map['financial'] || 0) > 0
  }
}

const getMessagesFromDB = async (sessionId) => {
  try {
    const getMessages = db.prepare(`
      SELECT role, content, message_order
      FROM messages 
      WHERE session_id = ? 
      ORDER BY message_order ASC
    `)
    const messages = await getMessages.all(sessionId)
    const safeMessages = Array.isArray(messages) ? messages : []
    if (!Array.isArray(messages)) {
      console.warn('getMessagesFromDB: unexpected messages', messages)
    }
    return safeMessages.map(msg => ({
      role: msg.role,
      content: JSON.parse(msg.content)
    }))
  } catch (error) {
    console.error(`❌ Ошибка получения сообщений из БД:`, error)
    return []
  }
}

// Хранилище для истории диалогов (в памяти) - теперь дублируется в БД
const conversationHistory = new Map()

// Хранилище для файлов по сессиям
// Формат: session -> [{fileId: string, originalName: string, size: number}]
const sessionFiles = new Map()

// Гварды, чтобы не запускать повторно анализы для одной и той же сессии
const runningStatementsSessions = new Set()
const runningTaxSessions = new Set()
const runningFsSessions = new Set()

const InvestmentAgentSchema = z.object({
  amount: z.number().nullable().optional(),
  term_months: z.number().nullable().optional(),
  completed: z.boolean().nullable().optional()
})

const investmentAgent = new Agent({
  name: 'Investment Agent',
  instructions: `Ты помощник регистрации заявок для инвестиций для iKapitalist. Собирай данные пошагово, задавай один вопрос за раз.

ВАЖНО: ПЕРЕД каждым ответом анализируй историю диалога, чтобы понять:
- На каком этапе находится диалог
- Какие данные уже собраны
- Какой следующий вопрос нужно задать

ЭТАПЫ СБОРА ДАННЫХ (после принятия условий):
1. "Какую сумму Вы хотите получить?" - получи сумму и убедись  что сумма между мин 10 миллионов- макс 1 миллиярд тенге
2. "На какой срок?" (в месяцах) - получи срок и убедись что срок между 4 и 36 месяцев
3. "Для чего Вы привлекаете финансирование?" - получи цель
4. "Пожалуйста, предоставьте Ваш БИН" - получи БИН и убедись что БИН состоит из 12 цифр
5. "Пожалуйста, прикрепите выписку с банка от юр лица за 12 месяцев" - получи выписки
6. После получения выписки - спроси есть ли еще выписки с этого или другихбанков за тот же период (повторяй до получения явного "нет")
7. ТОЛЬКО ПОСЛЕ ответа пользователя "нет" по другим банкам:
   7.0. Спроси про режим налогообложения: "Выберите какое налогообложение использует ваша компания:\n\nОбщеустановленный режим (ФНО 100.00 + 200.00 + 300.00)\n\nУпрощенная декларация (ФНО 910.00)\n\nСельхозпроизводитель (ФНО 920.00)\n\nДругое"
   7.1. ПОСЛЕ получения ответа пользователя про режим налогообложения - попроси загрузить НАЛОГОВУЮ отчетность: "Пожалуйста, предоставьте налоговую отчетность за текущий и предыдущий год в формате PDF". Четко укажи: формат PDF.
   7.1.1. После получения налоговой отчетности спроси: "Есть ли у вас еще файлы налоговой отчетности для загрузки? Если да, прикрепите их. Если нет, напишите 'нет'."
   7.1.2. Повторяй вопрос 7.1.1 до получения явного "нет"
   7.2. ТОЛЬКО ПОСЛЕ получения "нет" про налоговую отчетность — Попроси загрузить ФИНАНСОВУЮ отчетность (баланс, ОПУ) за текущий и предыдущий год в формате PDF.
   7.2.1. После получения финансовой отчетности спроси: "Есть ли у вас еще файлы финансовой отчетности для загрузки? Если да, прикрепите их. Если нет, напишите 'нет'."
   7.2.2. Повторяй вопрос 7.2.1 до получения явного "нет"
   7.3. ТОЛЬКО ПОСЛЕ получения "нет" про финансовую отчетность — "Пожалуйста, оставьте Ваши контактные данные: имя, фамилию, email и телефон" - получи контакты (убедись что номер начинается с +7 или 8 или 77 и состоит из 11 цифр но это пользователю не пиши)
8. После получения контактов - отправь финальное сообщение

ПРАВИЛА АНАЛИЗА ИСТОРИИ:
- Если в истории уже есть сумма (например, "90 мил", "90 млн") - НЕ спрашивай сумму снова
- Если в истории уже есть срок (например, "12 месяцев") - НЕ спрашивай срок снова
- Если в истории уже есть цель (например, "новый бизнес") - НЕ спрашивай цель снова
- Если в истории уже есть БИН (например, "100740014947") - НЕ спрашивай БИН снова
- Если пользователь говорит "ты же уже спрашивал" - переходи к следующему этапу

ПРИЕМ БАНКОВСКИХ ВЫПИСОК:

ОБЯЗАТЕЛЬНАЯ ПОСЛЕДОВАТЕЛЬНОСТЬ:
1. Собрать выписки за 12 месяцев (пользователь может загрузить несколько файлов одновременно)
2. После получения выписок спроси: "Есть ли у вас еще счета в других банках? Если да, прикрепите выписки за тот же период (12 месяцев). Если нет, напишите 'нет'."
3. Повторять пункт 2 до получения явного "нет"
4. Только после "нет" → запросить налоговую отчетность (PDF), затем финансовую отчетность (PDF), и лишь после их получения — переходить к контактным данным

Когда пользователь прикрепляет выписку/выписки с банка:

ВАЖНО: НЕ АНАЛИЗИРУЙ файлы! Просто прими их:
- Когда пользователь загружает файлы, просто подтверди прием: "Выписки приняты."
- Если загружено несколько файлов: "Выписки приняты (X файл(ов))."
- НЕ проверяй период выписки, НЕ извлекай даты, НЕ анализируй содержимое
- Просто принимай файлы и переходи к следующему вопросу

ПОСЛЕ приема выписок:
- Спроси: "Есть ли у вас еще счета в других банках? Если да, прикрепите выписки за 12 месяцев. Если нет, напишите 'нет'."

ТОЛЬКО ПОСЛЕ "нет" про другие банки:
- Сначала спроси про режим налогообложения: "Выберите какое налогообложение использует ваша компания:\n\nОбщеустановленный режим (ФНО 100.00 + 200.00 + 300.00)\n\nУпрощенная декларация (ФНО 910.00)\n\nСельхозпроизводитель (ФНО 920.00)\n\nДругое"
- ПОСЛЕ получения ответа пользователя про режим налогообложения - попроси: "Пожалуйста, предоставьте налоговую отчетность за текущий и предыдущий год в формате PDF"

НАЛОГОВАЯ ОТЧЕТНОСТЬ:
Когда пользователь прикрепляет налоговую отчетность:
- Подтверди прием: "Налоговая отчетность принята."
- Если загружено несколько файлов: "Налоговая отчетность принята (X файл(ов))."
- НЕ анализируй файлы, просто принимай их
- После приема налоговой отчетности СПРОСИ: "Есть ли у вас еще файлы налоговой отчетности для загрузки? Если да, прикрепите их. Если нет, напишите 'нет'."
- Повторяй этот вопрос до получения явного "нет"
- ТОЛЬКО ПОСЛЕ получения "нет" про налоговую отчетность переходи к запросу финансовой отчетности

- После получения "нет" про налоговую отчетность попроси: "Пожалуйста, предоставьте финансовую отчетность (баланс и отчет о прибылях и убытках) за текущий и предыдущий год в формате PDF."

ФИНАНСОВАЯ ОТЧЕТНОСТЬ:
Когда пользователь прикрепляет финансовую отчетность:
- Подтверди прием: "Финансовая отчетность принята."
- Если загружено несколько файлов: "Финансовая отчетность принята (X файл(ов))."
- НЕ анализируй файлы, просто принимай их
- После приема финансовой отчетности СПРОСИ: "Есть ли у вас еще файлы финансовой отчетности для загрузки? Если да, прикрепите их. Если нет, напишите 'нет'."
- Повторяй этот вопрос до получения явного "нет"
- ТОЛЬКО ПОСЛЕ получения "нет" про финансовую отчетность переходи к запросу контактных данных

- После получения "нет" про финансовую отчетность попроси контактные данные: имя, фамилия, email, телефон.
      
ВАЖНО: НЕ ПЕРЕХОДИ к контактам БЕЗ явного "нет"!
И НЕ ПЕРЕХОДИ к контактам БЕЗ получения "нет" по финансовой отчетности!

РАБОТА С ФАЙЛАМИ:
- Банковские выписки: ТОЛЬКО PDF файлы (mimetype application/pdf)
- Налоговая отчетность: ТОЛЬКО PDF файлы
- Финансовая отчетность: принимаем только PDF файлы для автоматического анализа
- Все файлы принимаются без проверки формата

КРИТИЧЕСКИЕ СЛУЧАИ:
Если клиент отказывается предоставить выписку за 12 месяцев, налоговую отчетность или финансовую отчетность ("нет под рукой", "не могу предоставить" и т.п.):
   Сказать: "Для рассмотрения заявки необходимы выписка за 12 месяцев, налоговую отчетность или финансовую отчетность. Пожалуйста, соберите все документы и подайте заявку заново. Диалог завершен."
   ЗАКРЫТЬ диалог.

КОНТАКТНЫЕ ДАННЫЕ:
Когда пользователь загрузил все необходимые документы:
   "Спасибо за предоставленные документы! Пожалуйста, оставьте ваши контактные данные: имя, фамилию, email и телефон."

ФИНАЛЬНОЕ СООБЩЕНИЕ:
Когда пользователь предоставил все контактные данные:
   "Спасибо за предоставленную информацию! Ваша заявка принята на рассмотрение. Мы проанализируем предоставленные документы и свяжемся с вами. Ожидайте уведомления от платформы iKapitalist."
   
   СОХРАНИ в историю отчёт для менеджера: сумма, срок, цель, БИН, выписки, контакты.

ВАЖНО: 
- Задавай один вопрос за раз, не повторяй предыдущие.
- Отвечай простыми вопросами, без технических данных.
- НЕ анализируй файлы при их получении - просто принимай их
- Позволяй пользователю загружать несколько файлов одновременно

АЛГОРИТМ РАБОТЫ:
1. Проанализируй всю историю диалога
2. Определи, какие данные уже собраны (сумма, срок, цель, БИН, выписки, контакты)
3. Найди первый недостающий этап
4. Задай только один вопрос по этому этапу
5. НЕ повторяй уже собранные данные`,
  model: 'gpt-5-mini',
  tools: [], // Убрали Code Interpreter - файлы не анализируются при загрузке
  modelSettings: { store: true }
})

// Функция для получения настроек агента из БД
const getAgentSettings = async (agentName) => {
  try {
    const getSettings = db.prepare(`
      SELECT instructions, mcp_config, model, model_settings, mcp_server_code, default_annual_rate
      FROM agent_settings 
      WHERE agent_name = ?
    `)
    const settings = await getSettings.get(agentName)
    return settings
  } catch (error) {
    console.error(`❌ Ошибка получения настроек агента ${agentName}:`, error)
    return null
  }
}

// Единый промпт по умолчанию для Information Agent (БД при старте + fallback в createInformationAgent)
const DEFAULT_INFORMATION_AGENT_INSTRUCTIONS = `Ты информационный агент краудфандинговой платформы iKapitalist.

Твоя цель — через короткий диалог помочь человеку понять возможности платформы и мягко подвести к подаче заявки, чтобы затем подключить инвестиционного агента. Общайся на русском языке, поддерживай живой диалог вопрос–ответ. Отвечай естественно, как будто ты знаешь всю информацию о платформе. НИКОГДА не упоминай MCP, инструменты или технические детали - просто отвечай на вопросы.

КРИТИЧЕСКИ ВАЖНО - ЗАПРЕТ НА ПРИВЕТСТВИЯ:
- НИКОГДА не здоровайся ("Здравствуйте", "Привет" и т.п.)
- НИКОГДА не представляйся ("Я — информационный агент", "Я агент iKapitalist" и т.п.)
- Пользователь УЖЕ знает, кто ты - просто отвечай на вопросы
- Если видишь в истории диалога, что пользователь уже общался с тобой - продолжай диалог, не начинай заново

АНАЛИЗ ИСТОРИИ ДИАЛОГА:
- ПЕРЕД каждым ответом анализируй всю историю диалога
- Если пользователь уже ответил на вопрос или выбрал опцию - НЕ повторяй этот вопрос
- Продолжай диалог с того места, где остановились

СТРУКТУРА ДИАЛОГА:
1. НИКОГДА не здоровайся и не представляйся. Пользователь уже знает, что ты информационный агент. Просто отвечай на вопросы.
2. Если пользователь спрашивает о платформе или хочет узнать подробнее - сразу давай информацию, без приветствий и без перечисления всех разделов.
3. НЕ перечисляй все разделы сразу. Если пользователь спрашивает общую информацию - спроси конкретно, что его интересует (условия, лицензия, продукты, расчёт займа, контакты).
4. После ответа давай только релевантную информацию (1–2 факта) и сразу уточняй, нужно ли продолжить или перейти к следующему пункту.
5. При вопросах об условиях, лицензии, рисках, продуктах — используй инструмент \`ikapitalist_get_section\` для получения информации и пересказывай кратко (до 3 предложений). НИКОГДА не упоминай, что используешь инструменты или MCP - просто отвечай, как будто знаешь эту информацию.
6. Отдельным коротким сообщением расскажи о комиссиях платформы (для компаний и инвесторов) и спроси, всё ли понятно.
7. Когда разговор касается финансирования, перечисли четыре вида займов (проценты ежемесячно, аннуитет, равные доли, всё в конце) и попроси выбрать интересующий формат.
8. Если клиент хочет расчёт или просит рассчитать займ:
   - Уточни сумму, срок (в месяцах), ставку (годовую в %)
   - ОБЯЗАТЕЛЬНО вызови инструмент \`ikapitalist_calculate_loan_schedule\` с параметрами:
     * loanType: выбранный тип займа (interest_only, equal_principal, fixed_payment, lump_sum)
     * amount: сумма займа (число)
     * termMonths: срок в месяцах (число)
     * annualRate: годовая ставка в долях (например, 0.30 для 30%)
   - Покажи ключевые цифры из результата (общая сумма процентов, общая сумма платежей, ежемесячный платеж)
   - Спроси о следующем шаге
9. Если клиент запрашивает контакты, адрес или другие детали - ответь кратко, уточнив, нужна ли ещё информация.
10. В конце, когда интерес подтверждён, предложи начать оформление и передай диалог инвестиционному агенту (сообщи, что он подключится для сбора данных).

ОБЩИЕ ПРАВИЛА:
- Каждое сообщение — максимум 3 коротких предложения или 3 пункта. Избегай длинных блоков текста.
- НИКОГДА не перечисляй все разделы или опции сразу - это слишком длинно и запутывает
- Всегда заканчивай сообщение вопросом или предложением следующего шага.
- НИКОГДА не упоминай MCP, инструменты, разделы MCP или технические детали - просто отвечай естественно
- НИКОГДА не говори "возьму раздел MCP", "использую инструмент" или подобное - просто отвечай на вопросы
- Не придумывай фактов; используй инструменты для получения информации, но не упоминай об этом пользователю
- НЕ повторяй уже заданные вопросы
- НИКОГДА не здоровайся ("Здравствуйте", "Привет" и т.п.) - это КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО
- НИКОГДА не представляйся ("Я — информационный агент", "Я агент iKapitalist" и т.п.) - это КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО
- Если пользователь отклоняет подачу заявки, уважай решение и предложи вернуться позже.`

const initDefaultAgentSettings = async () => {
  try {
    // Обновляем инструкции в БД, даже если запись уже существует
    const upsertSettings = db.prepare(`
      INSERT INTO agent_settings (agent_name, instructions, role, functionality, model, model_settings, default_annual_rate, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (agent_name) DO UPDATE SET
        instructions = EXCLUDED.instructions,
        role = EXCLUDED.role,
        functionality = EXCLUDED.functionality,
        model = EXCLUDED.model,
        model_settings = EXCLUDED.model_settings,
        default_annual_rate = COALESCE(EXCLUDED.default_annual_rate, agent_settings.default_annual_rate, 0.3),
        updated_at = CURRENT_TIMESTAMP
    `)
    await upsertSettings.run(
      'Information Agent',
      DEFAULT_INFORMATION_AGENT_INSTRUCTIONS,
      'Информационный консультант',
      'Отвечает на вопросы о платформе iKapitalist, помогает пользователям понять возможности платформы и подводит к подаче заявки',
      'gpt-5-mini',
      JSON.stringify({ store: true }),
      0.3 // Дефолтная ставка 30%
    )
    console.log('✅ Настройки для Information Agent обновлены в БД')
  } catch (error) {
    console.error('❌ Ошибка инициализации настроек по умолчанию:', error)
  }
}

// Инициализируем настройки по умолчанию при старте
initDefaultAgentSettings().catch(err => {
  console.error('❌ Ошибка при инициализации настроек:', err)
})

// Создаем Information Agent с настройками из БД
let informationAgent = null
let agentSettingsCache = null
let agentCacheTimestamp = 0
const CACHE_TTL = 60000 // 1 минута кэш

const createInformationAgent = async () => {
  const settings = await getAgentSettings('Information Agent')
  const instructions = settings?.instructions || DEFAULT_INFORMATION_AGENT_INSTRUCTIONS
  const model = settings?.model || 'gpt-5-mini'
  
  // Безопасный парсинг model_settings
  let modelSettings = { store: true }
  if (settings?.model_settings) {
    try {
      if (typeof settings.model_settings === 'string') {
        modelSettings = JSON.parse(settings.model_settings)
      } else if (typeof settings.model_settings === 'object') {
        modelSettings = settings.model_settings
      }
    } catch (error) {
      console.error('⚠️ Ошибка парсинга model_settings, используем значения по умолчанию:', error)
      modelSettings = { store: true }
    }
  }
  
  return new Agent({
    name: 'Information Agent',
    instructions,
    model,
    modelSettings,
    mcpServers: ikapInfoMcpServer ? [ikapInfoMcpServer] : []
  })
}

// Получаем или создаем агента с кэшированием
const getInformationAgent = async () => {
  const now = Date.now()
  if (!informationAgent || (now - agentCacheTimestamp) > CACHE_TTL) {
    informationAgent = await createInformationAgent()
    agentCacheTimestamp = now
    console.log('✅ Information Agent обновлен из БД')
  }
  return informationAgent
}

// Инициализируем агента при старте асинхронно
setImmediate(async () => {
  try {
    informationAgent = await createInformationAgent()
    agentCacheTimestamp = Date.now()
    console.log('✅ Information Agent инициализирован')
  } catch (error) {
    console.error('❌ Ошибка инициализации Information Agent:', error)
    // Создаем агента с дефолтными настройками
    informationAgent = new Agent({
      name: 'Information Agent',
      instructions: 'Ты информационный агент краудфандинговой платформы iKapitalist.',
      model: 'gpt-5-mini',
      modelSettings: { store: true },
      mcpServers: ikapInfoMcpServer ? [ikapInfoMcpServer] : []
    })
  }
})

// Middleware для логирования полей запроса перед multer
app.use('/api/agents/run', (req, res, next) => {
  try {
    next()
  } catch (error) {
    console.error('❌ Ошибка в middleware логирования:', error)
    next(error)
  }
})

// Middleware для обработки ошибок multer
const handleMulterError = (err, req, res, next) => {
  if (err) {
    if (err instanceof multer.MulterError) {
      console.error('❌ Multer Error:', err.code, err.message, err.field)
      console.error('❌ Request body keys:', Object.keys(req.body || {}))
      console.error('❌ Request files count:', req.files ? req.files.length : 0)
      
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          ok: false,
          error: 'Размер файла превышает 50 МБ',
          code: 'FILE_TOO_LARGE'
        })
      }
      
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({
          ok: false,
          error: 'Превышено максимальное количество файлов (10)',
          code: 'TOO_MANY_FILES'
        })
      }
      
      // Для ошибки "Unexpected field" - игнорируем и продолжаем с тем, что есть
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.message.includes('Unexpected field')) {
        console.warn('⚠️ Multer: неожиданное поле, но продолжаем обработку:', err.field || err.message)
        // Устанавливаем req.files если его нет, чтобы избежать ошибок дальше
        if (!req.files) {
          req.files = []
        }
        // Продолжаем обработку, игнорируя это поле
        return next()
      }
      
      // Для других ошибок multer - возвращаем ошибку
      return res.status(400).json({
        ok: false,
        error: `Ошибка загрузки файлов: ${err.message}`,
        code: 'MULTER_ERROR'
      })
    }
    // Для других ошибок передаем дальше
    return next(err)
  }
  next()
}

// Разрешаем до 50 файлов за один запрос от чата
app.post('/api/agents/run', upload.array('files', 50), handleMulterError, async (req, res) => {
  try {
    const { text, sessionId } = req.body
    const agentNameRaw = String(req.body.agent || '').toLowerCase()
    const agentName = agentNameRaw === 'information' ? 'information' : 'investment'
    const files = prepareUploadedFiles(req.files || [])
    let session = sessionId || `session_${Date.now()}`
    
    // Проверка длины текста сообщения (максимум 200 символов)
    const MAX_TEXT_LENGTH = 200
    if (text && text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({
        ok: false,
        error: `Сообщение слишком длинное. Максимальная длина: ${MAX_TEXT_LENGTH} символов.`,
        code: 'TEXT_TOO_LONG'
      })
    }
    
    console.log(`\n🤖 [${new Date().toLocaleTimeString()}] Новый запрос: "${text}" | Агент: ${agentName} | Сессия: ${session}${files.length > 0 ? ` | Файлов: ${files.length}` : ''}`)
    
    if (agentName === 'information' && files.length > 0) {
      return res.json({
        ok: false,
        message: 'Для получения информации о платформе файлы прикреплять не нужно.',
        sessionId: session
      })
    }
    
    // Команда сброса: начать новую заявку, игнорируя прошлую историю/сессию
    const normalizedText = String(text || '').toLowerCase()
    const isResetRequested = /\b(новая\s+заявка|сброс|reset|start\s+over)\b/i.test(normalizedText)
    if (isResetRequested) {
      console.log('🔄 Запрошен сброс диалога: создаем новую сессию и начинаем сначала')
      session = `session_${Date.now()}`
      conversationHistory.delete(sessionId)
    }

    // Получаем или создаем историю для этой сессии
    if (!conversationHistory.has(session)) {
      // Пытаемся восстановить историю из БД
      const dbMessages = await getMessagesFromDB(session)
      if (dbMessages.length > 0) {
        conversationHistory.set(session, dbMessages)
        console.log(`🔄 История восстановлена из БД: ${dbMessages.length} сообщений`)
      } else {
        conversationHistory.set(session, [])
        console.log(`🆕 Создана новая сессия`)
      }
    } else {
      console.log(`📚 История сессии: ${conversationHistory.get(session).length} сообщений`)
    }
    
    const history = conversationHistory.get(session)
    
    // Подготавливаем контент сообщения
    const messageContent = [{ type: 'input_text', text }]
    
    // Если есть файлы, сохраняем их локально (БЕЗ загрузки в OpenAI для Investment Agent)
    // Investment Agent не использует файлы напрямую - они обрабатываются локально,
    // а обработанные данные (JSON, TXT) загружаются в OpenAI для анализаторов
    const uploadedFileIds = []
    if (agentName === 'investment' && files && files.length > 0) {
      const fileNames = []
      
      for (const file of files) {
        try {
          // Проверяем, что buffer существует
          if (!file.buffer || !Buffer.isBuffer(file.buffer)) {
            throw new Error(`Файл ${file.originalname} не содержит buffer или buffer не является Buffer`)
          }
          
          // Генерируем локальный fileId (не загружаем в OpenAI)
          const localFileId = `local-${randomUUID()}`
          
          // Сохраняем файл в БД
          try {
            await saveFileToDatabase(file.buffer, session, localFileId, file.originalname, file.mimetype)
            console.log(`💾 Файл сохранен в БД: ${file.originalname} (${localFileId})`)
          } catch (dbError) {
            console.error(`⚠️ Ошибка сохранения файла в БД ${file.originalname}:`, dbError.message)
            throw dbError // Если не удалось сохранить в БД, это критично
          }
          
          uploadedFileIds.push(localFileId)
          fileNames.push(file.originalname)
          
          // Сохраняем файл в sessionFiles (в памяти) вместе с buffer для последующей обработки
          if (!sessionFiles.has(session)) {
            sessionFiles.set(session, [])
          }
          sessionFiles.get(session).push({
            fileId: localFileId,
            originalName: file.originalname,
            size: file.size,
            uploadedAt: new Date().toISOString(),
            buffer: file.buffer, // Сохраняем buffer для обработки через новый метод
            mimetype: file.mimetype
          })
          
          // Категоризируем и обновляем категорию файла в БД (файл уже сохранен с file_data)
          try {
            const category = categorizeUploadedFile(file.originalname, file.mimetype)
            await saveFileToDB(session, localFileId, file.originalname, file.size, file.mimetype, category, null)
          } catch (dbError) {
            // Проверяем, это ошибка разрыва соединения с БД
            if (dbError.code === 'XX000' || dbError.message?.includes('db_termination') || dbError.message?.includes('shutdown')) {
              console.error(`⚠️ БД соединение разорвано при обновлении категории файла ${file.originalname}. Продолжаем работу.`)
            } else {
              console.error(`⚠️ Ошибка обновления категории файла ${file.originalname} в БД (продолжаем работу):`, dbError.message)
            }
            // Продолжаем работу - файл уже сохранен в БД
          }
        } catch (error) {
          console.error(`❌ Ошибка обработки файла ${file.originalname}:`, error)
          console.error(`❌ Стек ошибки обработки файла:`, error.stack)
          fileNames.push(`${file.originalname} (ошибка обработки)`)
        }
      }
      
      console.log(`💾 Всего файлов в сессии: ${sessionFiles.get(session)?.length || 0}`)
      
      // Добавляем информацию о файлах в текст (без анализа)
      const filesInfo = fileNames.length === 1 
        ? `[Прикреплен файл: ${fileNames[0]}]`
        : `[Прикреплено файлов (${fileNames.length}): ${fileNames.join(', ')}]`
      messageContent[0].text += `\n\n${filesInfo}`
    }
    
    // Добавляем новое сообщение пользователя
    const userMessage = { role: 'user', content: messageContent }
    history.push(userMessage)
    
    // Сохраняем сообщение пользователя в БД (с обработкой ошибок)
    try {
      const messageOrder = history.length
      await saveMessageToDB(session, 'user', messageContent, messageOrder)
    } catch (dbError) {
      // Если БД недоступна, логируем но продолжаем работу
      if (dbError.code === 'XX000' || dbError.message?.includes('db_termination') || dbError.message?.includes('shutdown')) {
        console.error(`⚠️ БД соединение разорвано при сохранении сообщения. Продолжаем работу без сохранения в БД.`)
      } else {
        console.error(`⚠️ Ошибка сохранения сообщения в БД (продолжаем работу):`, dbError.message)
      }
      // Продолжаем работу даже если БД недоступна
    }
    
    const runner = new Runner({})

    console.log(`💰 Запуск Investment Agent...`)
    console.log(`📚 История для агента: ${history.length} сообщений`)

      const startTime = Date.now()
      console.log(`⏱️ Начало выполнения агента: ${new Date().toLocaleTimeString()}`)
      
      // НЕ используем Code Interpreter для анализа файлов - агент просто принимает файлы
      // Файлы сохранены локально, но НЕ загружены в OpenAI (это избыточно для Investment Agent)
      // Файлы будут обработаны локально, а обработанные данные (JSON, TXT) загрузятся в OpenAI для анализаторов
      const agentToRun = agentName === 'information' ? await getInformationAgent() : investmentAgent
      
      // Запускаем агента с таймаутом 30 минут (единый SLA)
      // Передаем всю историю - не можем обрезать из-за reasoning items в gpt-5
      const timeoutMs = 30 * 60 * 1000
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Agent timeout (${timeoutMs/1000}s)`)), timeoutMs)
      )
      
      let inv
      try {
        inv = await Promise.race([
          runner.run(agentToRun, [...history]),
          timeoutPromise
        ])
      } catch (error) {
        if (error.message.includes('timeout')) {
          console.error('⏰ Агент превысил таймаут')
          // Возвращаем ok: true чтобы разблокировать фронтенд
          return res.json({
            ok: true,
            message: 'Превышено время ожидания ответа. Пожалуйста, попробуйте еще раз.',
            sessionId: session
          })
        }
        // Обработка ошибки квоты OpenAI
        if (error.status === 429 || error.code === 'insufficient_quota') {
          console.error('💳 OpenAI квота исчерпана')
          return res.json({
            ok: false,
            message: 'Сервис временно недоступен. Пожалуйста, попробуйте позже.',
            sessionId: session
          })
        }
        throw error
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2)
      console.log(`⏱️ Агент выполнен за ${duration}s`)
      console.log(`🤖 Агент вернул: ${inv.newItems.length} новых элементов`)
      
      // Получаем текстовый ответ агента
      let agentMessage = 'Продолжаем сбор данных'
      
      // Ищем последнее сообщение от агента
      for (let i = inv.newItems.length - 1; i >= 0; i--) {
        const item = inv.newItems[i]
        if (item.rawItem?.role === 'assistant' && item.rawItem?.content?.[0]?.text) {
          agentMessage = item.rawItem.content[0].text
          break
        }
      }
      
      console.log(`💬 Ответ агента: "${agentMessage}"`)
      
      // Сохраняем ответ агента в историю
      const newItems = inv.newItems.map(item => item.rawItem)
      history.push(...newItems)
      console.log(`💾 История обновлена: ${history.length} сообщений`)

      // Если только что были загружены файлы и агент подтвердил их тип, проставим категорию
      // (теперь это опционально, так как файлы не анализируются при загрузке)
      if (uploadedFileIds && uploadedFileIds.length > 0 && typeof agentMessage === 'string') {
        const msg = agentMessage.toLowerCase()
        // Обновляем категорию для всех загруженных файлов, если агент упомянул тип
        for (const fileId of uploadedFileIds) {
          if (msg.includes('налог')) {
            updateFileCategoryInDB(fileId, 'taxes')
          } else if (msg.includes('финанс')) {
            updateFileCategoryInDB(fileId, 'financial')
          } else if (msg.includes('выписк')) {
            updateFileCategoryInDB(fileId, 'statements')
          }
        }
      }
      
      // Сохраняем новые сообщения агента в БД (с обработкой ошибок)
      for (let index = 0; index < newItems.length; index++) {
        const item = newItems[index]
        const messageOrder = history.length - newItems.length + index + 1
        const role = item && item.role
        const normalizedRole = normalizeMessageRole(role)
        if (normalizedRole) {
          try {
            await saveMessageToDB(session, normalizedRole, item.content, messageOrder)
          } catch (dbError) {
            // Если БД недоступна, логируем но продолжаем работу
            if (dbError.code === 'XX000' || dbError.message?.includes('db_termination') || dbError.message?.includes('shutdown')) {
              console.error(`⚠️ БД соединение разорвано при сохранении сообщения агента. Продолжаем работу без сохранения в БД.`)
            } else {
              console.error(`⚠️ Ошибка сохранения сообщения агента в БД (продолжаем работу):`, dbError.message)
            }
            // Продолжаем работу даже если БД недоступна
          }
        } else if (role && String(role).toLowerCase() !== 'tool') {
          // tool/другие роли из SDK не логируем как проблему
          console.warn(`⚠️ Пропущено сохранение сообщения без валидной роли: ${role}`)
        }
      }
      
      // Проверяем, это финальное сообщение (заявка завершена)
      const isFinalMessage = agentMessage.includes('Ваша заявка принята на рассмотрение') || 
                            agentMessage.includes('Ожидайте уведомления от платформы iKapitalist')
      
      if (agentName === 'investment' && isFinalMessage) {
        console.log(`✅ Заявка завершена! Генерируем финансовый отчет...`)
        
        // Генерируем отчет асинхронно (не блокируем ответ клиенту)
        setImmediate(async () => {
          // Определяем allFiles в начале для доступа в catch блоке
          let allFiles = []
          
          try {
            // Проверка гвардов, чтобы исключить двойной запуск
            if (runningStatementsSessions.has(session)) {
              console.log(`⏭️ Анализ банковских выписок уже запущен для ${session}, пропускаем`)
              return
            }
            runningStatementsSessions.add(session)
            
            // Если уже есть статус generating/completed, не запускаем
            const existing = await db.prepare('SELECT status FROM reports WHERE session_id = ?').get(session)
            if (existing && (existing.status === 'generating' || existing.status === 'completed')) {
              console.log(`⏭️ status=${existing.status} для ${session}, повторный запуск не требуется`)
              runningStatementsSessions.delete(session)
              return
            }
            
            // Получаем файлы из БД вместо памяти
            const getSessionFiles = db.prepare(`
              SELECT file_id, original_name, file_size, mime_type, category, uploaded_at
              FROM files 
              WHERE session_id = ? 
              ORDER BY uploaded_at ASC
            `)
            const dbFiles = await getSessionFiles.all(session)
            
            // Преобразуем в формат, совместимый со старым кодом
            allFiles = dbFiles.map(f => ({
              fileId: f.file_id,
              originalName: normalizeFileName(f.original_name),
              size: f.file_size,
              uploadedAt: f.uploaded_at,
              category: f.category
            }))
            
            // Фильтруем только банковские выписки для финансового аналитика
            const statementFiles = allFiles.filter(f => f.category === 'statements')
            
            if (statementFiles.length === 0) {
              console.log(`⚠️ Нет банковских выписок для анализа в БД`)
              runningStatementsSessions.delete(session)
              return
            }
            
            console.log(`📊 Генерация отчетов для ${statementFiles.length} банковских выписок (из ${allFiles.length} файлов)...`)
            
            // Извлекаем ключевую информацию из истории (без передачи всех сообщений)
            let amount = 'не указана'
            let termMonths = 'не указан'
            let purpose = 'не указана'
            let bin = 'не указан'
            let name = 'не указано'
            let email = 'не указан'
            let phone = 'не указан'
            
            // Парсим историю для извлечения данных
            const historyText = history.map(msg => {
              if (typeof msg.content === 'string') return msg.content
              if (Array.isArray(msg.content)) return msg.content.map(c => c.text || '').join(' ')
              return ''
            }).join(' ')
            
            // Извлечение данных из истории сообщений
            // Ищем сумму - сначала в последовательности вопрос-ответ
            for (let i = 0; i < history.length; i++) {
              const msg = history[i]
              if (msg.role === 'assistant') {
                const assistantText = typeof msg.content === 'string' 
                  ? msg.content 
                  : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : '')
                
                // Если агент спрашивает о сумме
                if (assistantText.match(/какую сумму|сумму.*получить/i)) {
                  console.log(`✅ Найден вопрос о сумме в элементе ${i}: "${assistantText.substring(0, 100)}"`)
                  // Берем следующее сообщение пользователя
                  if (i + 1 < history.length && history[i + 1].role === 'user') {
                    const userResponse = typeof history[i + 1].content === 'string'
                      ? history[i + 1].content
                      : (Array.isArray(history[i + 1].content) ? history[i + 1].content.map(c => c.text || '').join(' ') : '')
                    
                    // Ищем сумму в ответе пользователя
                    let amountMatch = userResponse.match(/(\d+)\s*(мил|млн|миллион)/i)
                    if (amountMatch) {
                      amount = `${amountMatch[1]} млн KZT`
                      break
                    }
                    
                    // Ищем большие суммы в виде цифр
                    amountMatch = userResponse.match(/(\d{7,})/g)
                    if (amountMatch) {
                      // Берем первое число >= 10 млн (7+ цифр)
                      const num = parseInt(amountMatch[0])
                      console.log(`💰 Найдено число: ${num}`)
                      if (num >= 10000000) {
                        amount = `${num} KZT`
                        console.log(`✅ Сумма установлена: ${amount}`)
                        break
                      } else {
                        console.log(`⚠️ Число ${num} меньше 10 млн, пропускаем`)
                      }
                    }
                    
                    // Ищем суммы с разделителями тысяч
                    amountMatch = userResponse.match(/(\d+)\s+(\d{3})\s+(\d{3})/)
                    if (amountMatch) {
                      const num = parseInt(amountMatch[1] + amountMatch[2] + amountMatch[3])
                      if (num >= 10000000) {
                        amount = `${num} KZT`
                        break
                      }
                    }
                    
                    // Ищем суммы с "тыс"
                    amountMatch = userResponse.match(/(\d+)\s*тыс/i)
                    if (amountMatch) {
                      const num = parseInt(amountMatch[1]) * 1000
                      if (num >= 10000000) {
                        amount = `${num} KZT`
                        break
                      }
                    }
                  }
                }
              }
            }
            
            // Если не нашли в последовательности, пробуем по ключевым словам
            if (amount === 'не указана') {
              let amountMatch = historyText.match(/(\d+)\s*(мил|млн|миллион)/i)
              if (amountMatch) {
                amount = `${amountMatch[1]} млн KZT`
              } else {
                // Ищем большие суммы в виде цифр
                amountMatch = historyText.match(/(\d{7,})/g)
                if (amountMatch) {
                  const num = parseInt(amountMatch[0])
                  console.log(`💰 Fallback: найдено число: ${num}`)
                  if (num >= 10000000) {
                    amount = `${num} KZT`
                    console.log(`✅ Fallback: сумма установлена: ${amount}`)
                  } else {
                    console.log(`⚠️ Fallback: число ${num} меньше 10 млн, пропускаем`)
                  }
                } else {
                  // Ищем суммы с разделителями тысяч
                  amountMatch = historyText.match(/(\d+)\s+(\d{3})\s+(\d{3})/)
                  if (amountMatch) {
                    const num = parseInt(amountMatch[1] + amountMatch[2] + amountMatch[3])
                    if (num >= 10000000) {
                      amount = `${num} KZT`
                    }
                  } else {
                    // Ищем суммы с "тыс"
                    amountMatch = historyText.match(/(\d+)\s*тыс/i)
                    if (amountMatch) {
                      const num = parseInt(amountMatch[1]) * 1000
                      if (num >= 10000000) {
                        amount = `${num} KZT`
                      }
                    }
                  }
                }
              }
            }
            
            // Ищем срок - сначала в последовательности вопрос-ответ
            for (let i = 0; i < history.length; i++) {
              const msg = history[i]
              if (msg.role === 'assistant') {
                const assistantText = typeof msg.content === 'string' 
                  ? msg.content 
                  : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : '')
                
                // Если агент спрашивает о сроке
                if (assistantText.match(/срок|месяц/i)) {
                  // Берем следующее сообщение пользователя
                  if (i + 1 < history.length && history[i + 1].role === 'user') {
                    const userResponse = typeof history[i + 1].content === 'string'
                      ? history[i + 1].content
                      : (Array.isArray(history[i + 1].content) ? history[i + 1].content.map(c => c.text || '').join(' ') : '')
                    
                    // Ищем число в ответе пользователя
                    const numberMatch = userResponse.match(/(\d+)/)
                    if (numberMatch) {
                      termMonths = `${numberMatch[1]} месяцев`
                      break
                    }
                  }
                }
              }
            }
            
            // Если не нашли в последовательности, пробуем по ключевым словам
            if (termMonths === 'не указан') {
              const termMatch = historyText.match(/(\d+)\s*месяц/i) || 
                               historyText.match(/срок[:\s]*(\d+)/i) ||
                               historyText.match(/(\d+)\s*мес/i) ||
                               historyText.match(/срок[^0-9]*(\d+)/i)
              if (termMatch) termMonths = `${termMatch[1]} месяцев`
            }
            
            const binMatch = historyText.match(/\b(\d{12})\b/)
            if (binMatch) bin = binMatch[1]
            
            // Ищем цель финансирования в истории
            // Сначала пытаемся найти в последовательности сообщений
            for (let i = 0; i < history.length; i++) {
              const msg = history[i]
              if (msg.role === 'assistant') {
                const assistantText = typeof msg.content === 'string' 
                  ? msg.content 
                  : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : '')
                
                // Если агент спрашивает о цели
                if (assistantText.match(/для чего|цел[ьи]|привлекаете финансирование/i)) {
                  // Берем следующее сообщение пользователя
                  if (i + 1 < history.length && history[i + 1].role === 'user') {
                    const userResponse = typeof history[i + 1].content === 'string'
                      ? history[i + 1].content
                      : (Array.isArray(history[i + 1].content) ? history[i + 1].content.map(c => c.text || '').join(' ') : '')
                    
                    // Очищаем от служебной информации о файлах и датах
                    purpose = userResponse
                      .replace(/\[Прикреплен файл.*?\]/g, '')
                      .replace(/\[ДАТА:.*?\]/g, '')
                      .replace(/^\s*\[.*?\]\s*/g, '') // Убираем любые [скобки] в начале
                      .trim()
                    if (purpose) break
                  }
                }
              }
            }
            
            // Если не нашли, пробуем по ключевым словам
            if (purpose === 'не указана') {
              const purposeKeywords = ['новый бизнес', 'расширение', 'оборотные средства', 'инвестиции', 'пополнение']
              for (const keyword of purposeKeywords) {
                if (historyText.toLowerCase().includes(keyword)) {
                  purpose = keyword
                  break
                }
              }
            }
            
            // Извлекаем контакты из ПОСЛЕДНЕГО сообщения пользователя
            const lastUserMessage = [...history].reverse().find(msg => msg.role === 'user')
            if (lastUserMessage) {
              const contactText = typeof lastUserMessage.content === 'string' 
                ? lastUserMessage.content 
                : (Array.isArray(lastUserMessage.content) 
                  ? lastUserMessage.content.map(c => c.text || '').join(' ') 
                  : '')
              
              const emailMatch = contactText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
              if (emailMatch) email = emailMatch[1]
              
              const phoneMatch = contactText.match(/(\+?\d[\d\s-]{9,})/g)
              if (phoneMatch) phone = phoneMatch[phoneMatch.length - 1]
              
              const nameMatch = contactText.match(/([А-Яа-яЁё]+\s+[А-Яа-яЁё]+)/i)
              if (nameMatch) name = nameMatch[1]
            }
            
            // Банковские выписки отправляются только в ikap2 (анализ не делается в ikap)
            if (statementFiles.length > 0) {
              if (!USE_IKAP2_FOR_STATEMENTS) {
                await upsertReport(session, {
                  status: 'error',
                  reportText: 'Для анализа банковских выписок настройте IKAP2_BACKEND_URL (https://ikap2-backend-latest.onrender.com).',
                  filesCount: statementFiles.length,
                  filesData: JSON.stringify(statementFiles.map(f => ({ name: f.originalName, size: f.size }))),
                })
                runningStatementsSessions.delete(session)
                return
              }
              console.log(`🔄 Отправляем ${statementFiles.length} банковских выписок в ikap2`)
              
              try {
                // Получаем файлы из sessionFiles (в памяти) или из БД
                const filesForIkap2 = []
                const sessionFilesData = sessionFiles.get(session) || []
                
                for (const file of statementFiles) {
                  let fileBuffer = null
                  
                  // Сначала пытаемся получить из sessionFiles (в памяти)
                  const sessionFile = sessionFilesData.find(f => f.fileId === file.fileId)
                  if (sessionFile && sessionFile.buffer) {
                    fileBuffer = sessionFile.buffer
                  } else {
                    // Если нет в памяти, пытаемся получить из БД
                    try {
                      const getFile = db.prepare(`
                        SELECT file_data FROM files WHERE file_id = ?
                      `)
                      const fileInfo = await getFile.get(file.fileId)
                      if (fileInfo && fileInfo.file_data) {
                        // PostgreSQL BYTEA возвращается как Buffer или строка
                        if (Buffer.isBuffer(fileInfo.file_data)) {
                          fileBuffer = fileInfo.file_data
                        } else if (typeof fileInfo.file_data === 'string') {
                          // Если это hex строка (начинается с \x)
                          if (fileInfo.file_data.startsWith('\\x')) {
                            fileBuffer = Buffer.from(fileInfo.file_data.slice(2), 'hex')
                          } else {
                            fileBuffer = Buffer.from(fileInfo.file_data, 'binary')
                          }
                        } else {
                          fileBuffer = Buffer.from(fileInfo.file_data)
                        }
                      } else if (!file.fileId.startsWith('local-')) {
                        // Если fileId не локальный, пытаемся получить из OpenAI Files API
                        try {
                          const fileContent = await openaiClient.files.retrieveContent(file.fileId)
                          fileBuffer = Buffer.from(fileContent)
                        } catch (openaiError) {
                          console.warn(`⚠️ Не удалось получить файл ${file.fileId} из OpenAI:`, openaiError.message)
                        }
                      }
                    } catch (dbError) {
                      console.warn(`⚠️ Не удалось получить файл ${file.fileId} из БД:`, dbError.message)
                      // Пытаемся получить из OpenAI, если fileId не локальный
                      if (!file.fileId.startsWith('local-')) {
                        try {
                          const fileContent = await openaiClient.files.retrieveContent(file.fileId)
                          fileBuffer = Buffer.from(fileContent)
                        } catch (openaiError) {
                          console.warn(`⚠️ Не удалось получить файл ${file.fileId} из OpenAI:`, openaiError.message)
                        }
                      }
                    }
                  }
                  
                  if (fileBuffer) {
                    filesForIkap2.push({
                      buffer: fileBuffer,
                      originalname: file.originalName,
                      mimetype: 'application/pdf',
                      size: file.size || fileBuffer.length
                    })
                  } else {
                    console.warn(`⚠️ Не удалось получить файл ${file.fileId} (${file.originalName}) для ikap2`)
                  }
                }
                
                if (filesForIkap2.length > 0) {
                  // Формируем комментарий для ikap2 (используем уже извлеченные данные)
                  const comment = `${bin !== 'не указан' ? `БИН: ${bin}` : ''} ${name !== 'не указано' ? `Имя: ${name}` : ''} ${email !== 'не указан' ? `Email: ${email}` : ''}`.trim()
                  
                  // Вызываем ikap2 для анализа
                  const ikap2Result = await proxyAnalysisToIkap2(session, comment || '', {}, filesForIkap2)
                  
                  if (ikap2Result && ikap2Result.sessionId) {
                    console.log(`✅ Анализ выписок выполнен через ikap2, sessionId: ${ikap2Result.sessionId}`)
                    
                    // Общее число файлов по сессии (выписки + налоги + фин. отчётность)
                    const fileCountRow = await db.prepare('SELECT COUNT(*) as cnt FROM files WHERE session_id = ?').get(session)
                    const totalFiles = (fileCountRow && fileCountRow.cnt != null) ? Number(fileCountRow.cnt) : filesForIkap2.length
                    
                    await upsertReport(session, {
                      status: ikap2Result.status || 'generating',
                      reportText: null,
                      reportStructured: null,
                      filesCount: totalFiles,
                      filesData: JSON.stringify(filesForIkap2.map(f => ({
                        name: f.originalname,
                        size: f.size,
                        mime: f.mimetype,
                      }))),
                      completed: null,
                      comment: comment || '',
                      company_bin: bin,
                      amount: amount,
                      term: termMonths,
                      purpose: purpose || null,
                      name: name,
                      email: email,
                      phone: phone,
                    })
                    
                    runningStatementsSessions.delete(session)
                    return // Прерываем выполнение, не используем старую логику
                  }
                } else {
                  await upsertReport(session, {
                    status: 'error',
                    reportText: 'Не удалось получить файлы для отправки в сервис анализа выписок (ikap2).',
                    filesCount: statementFiles.length,
                    filesData: JSON.stringify(statementFiles.map(f => ({ name: f.originalName, size: f.size }))),
                  })
                  runningStatementsSessions.delete(session)
                  return
                }
              } catch (ikap2Error) {
                console.error('❌ Ошибка при вызове ikap2 для анализа выписок:', ikap2Error.message)
                console.error('❌ Стек ошибки:', ikap2Error.stack)
                const errMsg = ikap2Error?.response?.data?.message || ikap2Error?.data?.message || ikap2Error.message
                await upsertReport(session, {
                  status: 'error',
                  reportText: `Ошибка сервиса анализа выписок (ikap2): ${errMsg}`,
                  filesCount: statementFiles.length,
                  filesData: JSON.stringify(statementFiles.map(f => ({ name: f.originalName, size: f.size }))),
                })
                runningStatementsSessions.delete(session)
                return
              }
            }
            
            // Если есть выписки, анализ делается только через ikap2 — сюда не доходим при statementFiles.length > 0
            if (statementFiles.length > 0) {
              runningStatementsSessions.delete(session)
              return
            }
            
          } catch (error) {
            console.error(`❌ Ошибка генерации отчета:`, error.message)
            console.error(`❌ Стек ошибки:`, error.stack)
            
            // Если это таймаут — НЕ помечаем отчет как error, оставляем status=generating.
            // Агент мог продолжить выполнение в OpenAI, и отчет придет позже.
            if (String(error.message || '').includes('timeout')) {
              console.warn('⏳ Обработка не успела за таймаут. Статус оставлен generating, отчет может появиться позже.')
            } else {
              // Сохраняем ошибку в БД
              const updateError = db.prepare(`
                UPDATE reports 
                SET report_text = ?, status = 'error', completed_at = CURRENT_TIMESTAMP
                WHERE session_id = ?
              `)
              await updateError.run(`Ошибка генерации отчета: ${error.message}`, session)
            }
          } finally {
            runningStatementsSessions.delete(session)
          }
        })
        
        // Параллельно запускаем анализ налоговой и фин. отчетности
        setImmediate(async () => {
          try {
            // Проверка гвардов, чтобы исключить двойной запуск
            if (runningTaxSessions.has(session)) {
              console.log(`⏭️ Налоговый анализ уже запущен для ${session}, пропускаем`)
              return
            }
            runningTaxSessions.add(session)
            
            // Если уже есть статус generating/completed, не запускаем
            const existing = await db.prepare('SELECT tax_status FROM reports WHERE session_id = ?').get(session)
            if (existing && (existing.tax_status === 'generating' || existing.tax_status === 'completed')) {
              console.log(`⏭️ tax_status=${existing.tax_status} для ${session}, повторный запуск не требуется`)
              runningTaxSessions.delete(session)
              return
            }
            
            // Собираем файлы налоговой отчетности
            const taxFilesRows = await db.prepare(`
              SELECT file_id, original_name, uploaded_at FROM files WHERE session_id = ? AND category = 'taxes' ORDER BY uploaded_at ASC
            `).all(session)
            const taxFilesRowsWithNames = (taxFilesRows || []).map(r => ({
              ...r,
              normalized_name: normalizeFileName(r.original_name || '')
            }))
            const taxFileIds = taxFilesRowsWithNames.map(r => r.file_id)
            const taxYearsMissing = []
            // Простая проверка покрытия двух лет по именам файлов
            const yearNow = new Date().getFullYear()
            const names = taxFilesRowsWithNames.map(r => r.normalized_name.toLowerCase())
            if (!names.some(n => n.includes(String(yearNow)))) taxYearsMissing.push(String(yearNow))
            if (!names.some(n => n.includes(String(yearNow - 1)))) taxYearsMissing.push(String(yearNow - 1))
            
            await db.prepare(`UPDATE reports SET tax_status = 'generating', tax_missing_periods = ? WHERE session_id = ?`).run(
              taxYearsMissing.length ? taxYearsMissing.join(',') : null, session
            )
            
            if (taxFileIds.length > 0) {
              const TAX_TIMEOUT_MS = 40 * 60 * 1000 // 40 минут на анализ
              
              // Получаем файлы из sessionFiles для парсинга
              const sessionFilesData = sessionFiles.get(session) || []
              
              // Преобразуем в удобный формат с проверкой наличия buffer в памяти
              const taxFiles = taxFilesRowsWithNames.map(r => {
                const sessionFile = sessionFilesData.find(f => f.fileId === r.file_id)
                return {
                  fileId: r.file_id,
                  originalName: r.normalized_name,
                  buffer: sessionFile?.buffer || null, // Используем buffer из памяти, если есть
                  mimetype: sessionFile?.mimetype || 'application/pdf'
                }
              })
              
              console.log(`\n📄 Начинаем парсинг ${taxFiles.length} налоговых PDF файлов в TXT...`)

              const USE_TAX_PDF_SERVICE_HTTP = !!process.env.TAX_PDF_SERVICE_URL

              // Получить buffer для одного налогового файла (память → БД → OpenAI)
              const getBufferForTaxFile = async (file) => {
                if (file.buffer && Buffer.isBuffer(file.buffer)) {
                  return file.buffer
                }
                let foundInDB = false
                let pdfBuffer = null
                try {
                  const fileInfo = await db.prepare('SELECT file_data FROM files WHERE file_id = ?').get(file.fileId)
                  if (fileInfo && fileInfo.file_data) {
                    if (Buffer.isBuffer(fileInfo.file_data)) pdfBuffer = fileInfo.file_data
                    else if (typeof fileInfo.file_data === 'string') {
                      pdfBuffer = fileInfo.file_data.startsWith('\\x')
                        ? Buffer.from(fileInfo.file_data.slice(2), 'hex')
                        : Buffer.from(fileInfo.file_data, 'binary')
                    } else pdfBuffer = Buffer.from(fileInfo.file_data)
                    foundInDB = true
                  }
                } catch (e) { /* ignore */ }
                if (!foundInDB && !file.fileId.startsWith('local-')) {
                  const pdfFileContent = await openaiClient.files.content(file.fileId)
                  pdfBuffer = Buffer.from(await pdfFileContent.arrayBuffer())
                } else if (!pdfBuffer) {
                  throw new Error(`Файл не найден: ${file.fileId}`)
                }
                return pdfBuffer
              }

              let parsedTexts = []
              let parseErrors = []

              if (USE_TAX_PDF_SERVICE_HTTP && taxFiles.length > 0) {
                // Один запрос в ikap3 на всю заявку — один анализ в списке сервиса
                const resolved = await Promise.allSettled(
                  taxFiles.map(async (file) => ({
                    buffer: await getBufferForTaxFile(file),
                    filename: file.originalName
                  }))
                )
                const batchFiles = resolved
                  .filter(r => r.status === 'fulfilled' && r.value && r.value.buffer)
                  .map(r => r.value)
                parseErrors = resolved
                  .filter(r => r.status === 'rejected')
                  .map(r => `Ошибка получения файла: ${r.reason?.message || 'Неизвестная ошибка'}`)

                if (batchFiles.length > 0) {
                  console.log(`📤 Один батч-запрос в ikap3 (taxpdfto): ${batchFiles.length} файлов`)
                  try {
                    const batchResult = await parseTaxPdfsBatchViaHttp(batchFiles, true)

                    // ✅ Основной путь: используем итоговый анализ от ikap3 (analysis_text),
                    // который совпадает с тем, что отображается в UI taxpdfto.
                    if (batchResult && typeof batchResult.analysis_text === 'string' && batchResult.analysis_text.trim()) {
                      let aiAnalysis = batchResult.analysis_text.trim()

                      // Нормализуем markdown-таблицы:
                      // 1) добавляем перевод строки между заголовком и строкой-разделителем, если они слиплись;
                      // 2) убираем пустые строки между строками таблицы, чтобы строки шли подряд.
                      aiAnalysis = aiAnalysis.replace(
                        /(\|[^\n]+?\|)\s*(\|[-:\s|]+\|)/g,
                        '$1\n$2'
                      )
                      aiAnalysis = aiAnalysis.replace(
                        /\n(\|[^\n]+\|)\n\n(?=\|[^\n]+\|)/g,
                        '\n$1\n'
                      )

                      console.log(`📊 Получен итоговый налоговый анализ от ikap3 (длина: ${aiAnalysis.length} символов после нормализации)`)

                      try {
                        await db.prepare(`
                          UPDATE reports
                          SET tax_report_text = ?, tax_status = 'completed'
                          WHERE session_id = ?
                        `).run(aiAnalysis, session)
                        console.log('✅ Налоговый отчет (analysis_text) сохранен в БД')
                      } catch (dbError) {
                        console.error('❌ Ошибка сохранения налогового отчета (analysis_text) в БД:', dbError.message)
                      }

                      // История и структурированные данные уже сохранены в taxpdfto (ikap3),
                      // поэтому здесь можно завершить налоговый анализ для данной сессии.
                      return
                    }

                    // Fallback: старый путь через per-file analysis, если analysis_text отсутствует
                    const files = Array.isArray(batchResult.files) ? batchResult.files : []
                    parsedTexts = files.map((f) => ({
                      fileName: f.filename || f.fileName || 'document.pdf',
                      text: f.text || '',
                      analysis: f.analysis || null
                    }))
                    parsedTexts.forEach((item) => {
                      if (item.analysis) {
                        console.log(`✅ Анализ от taxpdfto для "${item.fileName}": ${item.analysis.length} символов`)
                      }
                    })
                  } catch (batchErr) {
                    parseErrors.push(`Батч-запрос к ikap3: ${batchErr.message}`)
                    console.error('❌ Батч taxpdfto:', batchErr.message)
                  }
                }
              } else {
                // Пофайловый парсинг (локальный Python или fallback)
                const parseSingleTaxFile = async (file) => {
                  console.log(`🔄 Парсим PDF: ${file.originalName}`)
                  const pdfBuffer = await getBufferForTaxFile(file)
                  const parseResult = await parseTaxPdfToText(pdfBuffer, file.originalName, false)
                  if (!parseResult?.text?.trim()) throw new Error('Парсинг PDF вернул пустой текст')
                  const result = { fileName: file.originalName, text: parseResult.text }
                  if (parseResult.analysis) result.analysis = parseResult.analysis
                  return result
                }
                const TAX_BATCH_SIZE = 5
                const runBatch = (batch) => Promise.allSettled(batch.map(file => parseSingleTaxFile(file)))
                const parseResults = []
                for (let i = 0; i < taxFiles.length; i += TAX_BATCH_SIZE) {
                  const batchResults = await runBatch(taxFiles.slice(i, i + TAX_BATCH_SIZE))
                  parseResults.push(...batchResults)
                }
                parseResults.forEach((result, index) => {
                  if (result.status === 'fulfilled') parsedTexts.push(result.value)
                  else parseErrors.push(`Ошибка парсинга файла "${taxFiles[index].originalName}": ${result.reason?.message || 'Неизвестная ошибка'}`)
                })
              }
              
              if (parsedTexts.length === 0) {
                const errorMessage = 'Нет файлов для анализа'
                await db.prepare(`UPDATE reports SET tax_status = 'error', tax_report_text = ? WHERE session_id = ?`).run(errorMessage, session)
                console.error(`❌ ${errorMessage}`)
                return
              }
              
              if (parseErrors.length > 0) {
                const warningMessage = `Не удалось распарсить некоторые PDF файлы (анализ выполняется по успешно распарсенным):\n${parseErrors.join('\n')}`
                console.warn(`⚠️ ${warningMessage}`)
              }
              
              console.log(`✅ Успешно распарсены ${parsedTexts.length} PDF файлов из ${taxFiles.length}`)

              // Проверяем, есть ли готовые анализы от taxpdfto
              const hasReadyAnalyses = parsedTexts.some(item => item.analysis)
              
              let combinedTaxReport = ''
              const analysisErrors = []

              if (hasReadyAnalyses) {
                // Если есть готовые анализы от taxpdfto, используем их
                console.log(`📊 Используем готовые анализы от taxpdfto`)
                
                for (let i = 0; i < parsedTexts.length; i += 1) {
                  const item = parsedTexts[i]
                  
                  if (item.analysis) {
                    // Добавляем анализ с разделителем
                    combinedTaxReport += `\n${'='.repeat(80)}\nОТЧЕТ ${i + 1} ИЗ ${parsedTexts.length}\nФайл: ${item.fileName}\n${'='.repeat(80)}\n\n`
                    combinedTaxReport += item.analysis.trim()
                    combinedTaxReport += '\n\n'
                    console.log(`✅ Добавлен анализ для файла "${item.fileName}"`)
                  } else {
                    // Если для файла нет анализа, добавляем предупреждение
                    const warning = `⚠️ Анализ для файла "${item.fileName}" не был получен от taxpdfto`
                    analysisErrors.push(warning)
                    console.warn(warning)
                  }
                }
              } else {
                // Налоговый анализ делается только через ikap3 (taxpdfto). Агенты в ikap не используются.
                const errMsg = process.env.TAX_PDF_SERVICE_URL
                  ? 'Сервис налоговых деклараций (ikap3) не вернул анализ. Убедитесь, что TAX_PDF_SERVICE_URL указывает на https://ikap3-backend-latest.onrender.com и сервис доступен.'
                  : 'Для анализа налоговых деклараций настройте TAX_PDF_SERVICE_URL (https://ikap3-backend-latest.onrender.com).'
                console.error(`❌ ${errMsg}`)
                try {
                  await db.prepare(`UPDATE reports SET tax_status = 'error', tax_report_text = ? WHERE session_id = ?`).run(errMsg, session)
                } catch (dbError) {
                  console.error(`❌ Ошибка сохранения статуса ошибки в БД:`, dbError.message)
                }
                return
              }

              if (!combinedTaxReport) {
                const errorMessage = `Ошибка анализа: ни один из батчей не был успешно обработан. Ошибки: ${analysisErrors.join(' | ')}`
                console.error(`❌ ${errorMessage}`)
                try {
                  await db.prepare(`UPDATE reports SET tax_status = 'error', tax_report_text = ? WHERE session_id = ?`).run(errorMessage, session)
                } catch (dbError) {
                  console.error(`❌ Ошибка сохранения статуса ошибки в БД:`, dbError.message)
                }
                return
              }

              // Если были ошибки парсинга или анализа отдельных батчей - добавляем их в конец отчета
              if (parseErrors.length > 0 || analysisErrors.length > 0) {
                combinedTaxReport += `\n\n${'='.repeat(80)}\n⚠️ ДОПОЛНИТЕЛЬНАЯ ИНФОРМАЦИЯ\n${'='.repeat(80)}\n`
                if (parseErrors.length > 0) {
                  combinedTaxReport += `\nФАЙЛЫ С ОШИБКАМИ ПРИ ПАРСИНГЕ:\n${parseErrors.join('\n')}\n`
                }
                if (analysisErrors.length > 0) {
                  combinedTaxReport += `\nБАТЧИ С ОШИБКАМИ ПРИ АНАЛИЗЕ:\n${analysisErrors.join('\n')}\n`
                }
              }

              console.log(`✅ Анализ налоговых файлов завершен для всех батчей`)
              console.log(`📄 Размер итогового отчета: ${combinedTaxReport.length} символов`)
              if (combinedTaxReport.length > 0) {
                const preview = combinedTaxReport.substring(0, 200).replace(/\n/g, ' ')
                console.log(`📋 Превью отчета: ${preview}...`)
              }

              // Сохраняем объединенный отчет в БД
              console.log(`💾 Сохраняем налоговый отчет в БД...`)
              try {
                await db.prepare(`UPDATE reports SET tax_report_text = ?, tax_status = 'completed' WHERE session_id = ?`).run(combinedTaxReport, session)
                console.log(`✅ Налоговый отчет сохранен для ${parsedTexts.length} файлов`)
              } catch (dbError) {
                console.error(`❌ Ошибка сохранения налогового отчета в БД:`, dbError.message)
                // Пробуем еще раз через небольшую задержку
                await new Promise((resolve) => setTimeout(resolve, 500))
                try {
                  await db.prepare(`UPDATE reports SET tax_report_text = ?, tax_status = 'completed' WHERE session_id = ?`).run(combinedTaxReport, session)
                  console.log(`✅ Налоговый отчет сохранен после retry`)
                } catch (retryError) {
                  console.error(`❌ Ошибка сохранения после retry:`, retryError.message)
                  // Продолжаем работу, отчет все равно будет доступен в памяти
                }
              }
            } else {
              try {
                await db.prepare(`UPDATE reports SET tax_status = 'error', tax_report_text = 'Файлы налоговой отчетности не найдены' WHERE session_id = ?`).run(session)
              } catch (dbError) {
                console.error(`❌ Ошибка сохранения статуса ошибки в БД:`, dbError.message)
              }
            }
          } catch (e) {
            console.error('❌ Ошибка запуска налогового анализа:', e)
          } finally {
            runningTaxSessions.delete(session)
          }
        })

        setImmediate(async () => {
          try {
            if (runningFsSessions.has(session)) {
              console.log(`⏭️ Фин. анализ уже запущен для ${session}, пропускаем`)
              return
            }
            runningFsSessions.add(session)
            const existing = await db.prepare('SELECT fs_status FROM reports WHERE session_id = ?').get(session)
            if (existing && (existing.fs_status === 'generating' || existing.fs_status === 'completed')) {
              console.log(`⏭️ fs_status=${existing.fs_status} для ${session}, повторный запуск не требуется`)
              runningFsSessions.delete(session)
              return
            }
            // Собираем файлы финансовой отчетности
            const fsFilesRows = await db.prepare(`
              SELECT file_id, original_name, uploaded_at FROM files WHERE session_id = ? AND category = 'financial' ORDER BY uploaded_at ASC
            `).all(session)
            const fsFilesRowsWithNames = (fsFilesRows || []).map(r => ({
              ...r,
              normalized_name: normalizeFileName(r.original_name || '')
            }))
            const fsFileIds = fsFilesRowsWithNames.map(r => r.file_id)
            const fsYearsMissing = []
            const yearNow = new Date().getFullYear()
            const names = fsFilesRowsWithNames.map(r => r.normalized_name.toLowerCase())
            if (!names.some(n => n.includes(String(yearNow)))) fsYearsMissing.push(String(yearNow))
            if (!names.some(n => n.includes(String(yearNow - 1)))) fsYearsMissing.push(String(yearNow - 1))
            await db.prepare(`UPDATE reports SET fs_status = 'generating', fs_missing_periods = ? WHERE session_id = ?`).run(
              fsYearsMissing.length ? fsYearsMissing.join(',') : null, session
            )
            
            // Фильтруем только PDF файлы (XLSX больше не поддерживаются)
            const pdfFiles = fsFilesRowsWithNames.filter(f => {
              const name = f.normalized_name.toLowerCase()
              return name.endsWith('.pdf')
            })
            const nonPdfFiles = fsFilesRowsWithNames.filter(f => {
              const name = f.normalized_name.toLowerCase()
              return !name.endsWith('.pdf')
            })
            
            const fsFileReports = [] // Массив отчетов для всех файлов
            // ВАЖНО: Эти переменные должны быть видимы в блоке сохранения отчёта ниже,
            // иначе при отсутствии PDF получим ReferenceError.
            let fsTable = []
            let fsYears = []
            let fsSummary = ''
            
            // Обрабатываем PDF файлы через ikap4 (pdftopng)
            if (pdfFiles.length > 0) {
              const sessionFilesData = sessionFiles.get(session) || []
              const pdfFilesWithBuffers = pdfFiles
                .map(pdfFile => {
                  const sessionFile = sessionFilesData.find(f => f.fileId === pdfFile.file_id)
                  if (sessionFile && sessionFile.buffer) {
                    return {
                      buffer: sessionFile.buffer,
                      originalName: pdfFile.normalized_name,
                      fileId: pdfFile.file_id
                    }
                  }
                  return null
                })
                .filter(Boolean)

              // Финансовая отчётность отправляется только в ikap4 (pdftopng). Агенты в ikap не используются.
              if (USE_FINANCIAL_PDF_SERVICE && pdfFilesWithBuffers.length > 0) {
                console.log(`\n📄 Отправляем ${pdfFilesWithBuffers.length} PDF на ikap4 (pdftopng, фин. отчётность)...`)
                try {
                  const { report, table, years, summary } = await analyzeFinancialPdfsViaPdftopng(pdfFilesWithBuffers)
                  fsTable = table || []
                  fsYears = years || []
                  fsSummary = summary || ''

                  // Формируем один общий отчёт по всем PDF, как в интерфейсе ikap4
                  const combinedName = pdfFilesWithBuffers.length === 1
                    ? pdfFilesWithBuffers[0].originalName
                    : `Отчёт (${pdfFilesWithBuffers.length} файлов): ${pdfFilesWithBuffers.map(f => f.originalName).join(', ')}`

                  fsFileReports.push({
                    fileId: pdfFilesWithBuffers[0].fileId,
                    fileName: combinedName,
                    report
                  })
                } catch (err) {
                  console.error(`❌ Ошибка ikap4 (pdftopng):`, err.message)
                  pdfFilesWithBuffers.forEach(f => {
                    fsFileReports.push({
                      fileId: f.fileId,
                      fileName: f.originalName,
                      report: `Ошибка анализа через ikap4 (pdftopng): ${err.message}`
                    })
                  })
                }
              } else {
                const errMsg = !USE_FINANCIAL_PDF_SERVICE
                  ? 'Для анализа финансовой отчётности настройте FINANCIAL_PDF_SERVICE_URL (https://ikap4-backend.onrender.com).'
                  : 'Buffer файлов не найден для обработки'
                console.error(`❌ ${errMsg}`)
                pdfFiles.forEach(pdfFile => {
                  fsFileReports.push({
                    fileId: pdfFile.file_id,
                    fileName: pdfFile.normalized_name,
                    report: `Ошибка: ${errMsg}`
                  })
                })
              }
            }
            
            // Сохраняем объединенный отчет (только PDF)
            if (fsFileReports.length > 0) {
              let combinedFsReport
              if (fsFileReports.length === 1) {
                // Обычный сценарий: один общий отчёт по нескольким файлам
                const fr = fsFileReports[0]
                combinedFsReport = `\n\n${'='.repeat(80)}\nОТЧЕТ 1 из 1\nФайл: ${fr.fileName}\n${'='.repeat(80)}\n\n${fr.report}`
              } else {
                // Редкий сценарий с ошибками по отдельным файлам — сохраняем по-старому, чтобы видеть, что упало
                combinedFsReport = fsFileReports.map((fr, idx) => {
                  return `\n\n${'='.repeat(80)}\nОТЧЕТ ${idx + 1} из ${fsFileReports.length}\nФайл: ${fr.fileName}\n${'='.repeat(80)}\n\n${fr.report}`
                }).join('\n\n')
              }

              // Нормализуем markdown-таблицы в текстовом отчете (для совместимости),
              // но основной источник таблицы для фронта — это fs_report_structured (JSON).
              combinedFsReport = combinedFsReport.replace(
                /(\|[^\n]+?\|)\s*(\|[-:\s|]+\|)/g,
                '$1\n$2'
              )
              combinedFsReport = combinedFsReport.replace(
                /\n(\|[^\n]+\|)\n\n(?=\|[^\n]+\|)/g,
                '\n$1\n'
              )
              
              if (nonPdfFiles.length > 0) {
                const nonPdfNames = nonPdfFiles.map(f => f.normalized_name).join(', ')
                combinedFsReport += `\n\n⚠️ Файлы некорректного формата (не проанализированы): ${nonPdfNames}. Для автоматического анализа требуется формат PDF.`
              }
              
              // Сохраняем объединенный отчет в БД
              console.log(`💾 Сохраняем ${fsFileReports.length} финансовых отчетов в БД...`)
              let fsStructured = null
              try {
                fsStructured = JSON.stringify({ table: fsTable, years: fsYears, summary: fsSummary })
              } catch (e) {
                console.warn('⚠️ Не удалось сериализовать fs_report_structured:', e.message)
              }
              await db.prepare(`UPDATE reports SET fs_report_text = ?, fs_report_structured = ?, fs_status = 'completed' WHERE session_id = ?`).run(
                combinedFsReport,
                fsStructured,
                session
              )
              console.log(`✅ Финансовые отчеты сгенерированы для всех ${fsFileReports.length} файлов`)
            } else if (fsFileIds.length > 0) {
              // Есть файлы, но не удалось их обработать
              const allFileNames = fsFilesRowsWithNames.map(f => f.normalized_name).join(', ')
              const pdfFileNames = pdfFiles.map(f => f.normalized_name).join(', ')
              const nonPdfFileNames = nonPdfFiles.map(f => f.normalized_name).join(', ')
              
              let errorMessage = ''
              if (pdfFiles.length > 0 && nonPdfFiles.length > 0) {
                errorMessage = `Не удалось обработать PDF файлы: ${pdfFileNames}. Также найдены файлы некорректного формата: ${nonPdfFileNames}. Для автоматического анализа требуется формат PDF.`
              } else if (pdfFiles.length > 0) {
                errorMessage = `Не удалось обработать файлы финансовой отчетности: ${pdfFileNames}. Проверьте формат файлов (требуется PDF).`
              } else {
                errorMessage = `Файлы некорректного формата: ${nonPdfFileNames}. Для автоматического анализа требуется формат PDF.`
              }
              
              await db.prepare(`UPDATE reports SET fs_status = 'error', fs_report_text = ? WHERE session_id = ?`).run(
                errorMessage,
                session
              )
            } else {
              await db.prepare(`UPDATE reports SET fs_status = 'error', fs_report_text = 'Файлы финансовой отчетности не найдены' WHERE session_id = ?`).run(session)
            }
          } catch (e) {
            console.error('❌ Ошибка запуска анализа фин. отчетности:', e)
          } finally {
            runningFsSessions.delete(session)
          }
        })
      }
      
      if (agentName === 'investment') {
        // Возвращаем прогресс по факту загруженных файлов
        const progress = await getSessionProgress(session)
        return res.json({ 
          ok: true, 
          message: agentMessage,
          sessionId: session,
          completed: isFinalMessage,
          data: { progress }
        })
      }

      return res.json({
        ok: true,
        message: agentMessage,
        sessionId: session,
        completed: false
      })
  } catch (e) {
    console.error('❌ Ошибка в /api/agents/run:', e)
    console.error('❌ Стек ошибки:', e.stack)
    console.error('❌ Детали ошибки:', {
      name: e.name,
      message: e.message,
      code: e.code,
      stack: e.stack
    })
    
    // Обработка ошибок Multer
    if (e.name === 'MulterError') {
      console.error('❌ Multer Error:', e.message, e.code)
      
      // Обработка ошибки размера файла
      if (e.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          ok: false, 
          error: 'Размер файла превышает 50 МБ. Пожалуйста, выберите файл меньшего размера.',
          code: 'FILE_TOO_LARGE'
        })
      }
      
      // Обработка других ошибок Multer
      return res.status(400).json({ 
        ok: false, 
        error: `Ошибка загрузки файла: ${e.message}`,
        details: e.code === 'LIMIT_UNEXPECTED_FILE' 
          ? 'Неожиданное поле. Используйте поле "files" для загрузки файлов.'
          : e.message,
        code: e.code
      })
    }
    
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

// ========== ЭНДПОИНТ /api/analysis ДЛЯ ОБРАБОТКИ БАНКОВСКИХ ВЫПИСОК ==========
// Проксирование запросов на ikap2 для анализа выписок

// Банковские выписки отправляются только в ikap2 (анализ не делается в ikap)
const IKAP2_BACKEND_URL = process.env.IKAP2_BACKEND_URL || 'https://ikap2-backend-latest.onrender.com'
const USE_IKAP2_FOR_STATEMENTS = !!IKAP2_BACKEND_URL

/**
 * Проксирует запрос анализа выписок на ikap2
 */
async function proxyAnalysisToIkap2(sessionId, comment, metadata, files) {
  try {
    console.log(`🔄 Проксирую запрос на анализ в ikap2: ${IKAP2_BACKEND_URL}/api/analysis`, {
      sessionId,
      commentLength: comment.length,
      filesCount: files.length,
      metadata,
    })

    const formData = new FormData()
    
    if (sessionId) {
      formData.append('sessionId', sessionId)
    }
    
    if (comment) {
      formData.append('comment', comment)
    }
    
    if (metadata && typeof metadata === 'object') {
      formData.append('metadata', JSON.stringify(metadata))
    }
    
    // Добавляем файлы
    for (const file of files) {
      formData.append('files', file.buffer, {
        filename: file.originalname || file.originalName || 'file.pdf',
        contentType: file.mimetype || 'application/pdf',
      })
    }

    // Отправляем запрос на ikap2 с заголовком x-external-service
    const response = await axios.post(
      `${IKAP2_BACKEND_URL}/api/analysis`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'X-External-Service': 'ikap',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 300000, // 5 минут таймаут для больших файлов
      }
    )

    console.log(`✅ Получен ответ от ikap2:`, {
      status: response.status,
      sessionId: response.data?.sessionId,
      ok: response.data?.ok,
    })

    return response.data
  } catch (error) {
    console.error('❌ Ошибка при проксировании запроса на ikap2:', error.message)
    
    if (error.response) {
      // Если ikap2 вернул ошибку, пробрасываем её
      throw {
        status: error.response.status,
        data: error.response.data || {
          ok: false,
          code: 'IKAP2_ERROR',
          message: error.response.statusText || 'Ошибка при обращении к сервису анализа',
        },
      }
    }
    
    // Если это сетевая ошибка
    throw {
      status: 502,
      data: {
        ok: false,
        code: 'IKAP2_CONNECTION_ERROR',
        message: `Не удалось связаться с сервисом анализа: ${error.message}`,
      },
    }
  }
}

const activeAnalysisSessions = new Set()

const summariseFilesForLog = (files = []) =>
  files.map((file, index) => ({
    name: normalizeFileName(file?.originalname || file?.originalName || file?.name || `file_${index}`),
    size: file?.size,
    mime: file?.mimetype || file?.mime_type || file?.mime,
  }))

const upsertReport = async (sessionId, payload) => {
  const {
    status, reportText, reportStructured, filesCount, filesData,
    completed, comment, openaiResponseId, openaiStatus,
    company_bin, amount, term, purpose, name, email, phone,
  } = payload
  try {
    const stmt = db.prepare(`
      INSERT INTO reports (session_id, status, report_text, report_structured, files_count, files_data, completed_at, comment, openai_response_id, openai_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        report_text = excluded.report_text,
        report_structured = COALESCE(excluded.report_structured, reports.report_structured),
        files_count = excluded.files_count,
        files_data = excluded.files_data,
        completed_at = excluded.completed_at,
        comment = COALESCE(excluded.comment, reports.comment),
        openai_response_id = COALESCE(excluded.openai_response_id, reports.openai_response_id),
        openai_status = COALESCE(excluded.openai_status, reports.openai_status)
    `)
    await stmt.run(
      sessionId, status, reportText || null, reportStructured || null,
      typeof filesCount === 'number' ? filesCount : null, filesData || null,
      completed || null, comment ?? null, openaiResponseId ?? null, openaiStatus ?? null
    )
    // Заполняем карточку заявки (БИН, сумма, срок, контакт), если переданы
    const hasCardFields = [company_bin, amount, term, purpose, name, email, phone].some(v => v !== undefined && v !== null)
    if (hasCardFields) {
      await db.prepare(`
        UPDATE reports SET
          company_bin = COALESCE(?, company_bin),
          amount = COALESCE(?, amount),
          term = COALESCE(?, term),
          purpose = COALESCE(?, purpose),
          name = COALESCE(?, name),
          email = COALESCE(?, email),
          phone = COALESCE(?, phone)
        WHERE session_id = ?
      `).run(company_bin ?? null, amount ?? null, term ?? null, purpose ?? null, name ?? null, email ?? null, phone ?? null, sessionId)
    }
  } catch (error) {
    console.error('❌ Ошибка сохранения отчёта в БД:', error)
  }
}

app.post('/api/analysis', upload.array('files'), handleMulterError, async (req, res) => {
  const startedAt = new Date()
  const incomingSession = req.body?.sessionId
  const sessionId = incomingSession || randomUUID()
  const comment = (req.body?.comment || '').toString().trim()
  const metadata = transactionProcessor.normalizeMetadata(req.body?.metadata)
  const files = prepareUploadedFiles(req.files || [])

  console.log('🛰️ Получен запрос /api/analysis', {
    sessionId,
    commentLength: comment.length,
    files: summariseFilesForLog(files),
    metadata,
    useIkap2: USE_IKAP2_FOR_STATEMENTS,
  })

  // Если включено использование ikap2, проксируем запрос туда
  if (USE_IKAP2_FOR_STATEMENTS) {
    if (activeAnalysisSessions.has(sessionId)) {
      console.warn('⚠️ Попытка запустить анализ для сессии, которая уже обрабатывается:', sessionId)
      return res.status(409).json({
        ok: false,
        code: 'ANALYSIS_IN_PROGRESS',
        message: 'Анализ для этой сессии уже выполняется. Пожалуйста, подождите.',
        sessionId,
      })
    }

    activeAnalysisSessions.add(sessionId)

    if (!files.length) {
      console.error('❌ Запрос без файлов, возвращаем 400')
      activeAnalysisSessions.delete(sessionId)
      return res.status(400).json({
        ok: false,
        code: 'FILES_REQUIRED',
        message: 'Необходимо прикрепить хотя бы один файл для анализа.',
      })
    }

    try {
      const result = await proxyAnalysisToIkap2(sessionId, comment, metadata, files)
      activeAnalysisSessions.delete(sessionId)
      
      // Сохраняем результат в локальной БД для совместимости с фронтендом ikap
      if (result.sessionId) {
        try {
          await upsertReport(result.sessionId, {
            status: 'generating',
            reportText: null,
            reportStructured: null,
            filesCount: files.length,
            filesData: JSON.stringify(files.map(f => ({
              name: f.originalname || f.originalName,
              size: f.size,
              mime: f.mimetype,
            }))),
            completed: null,
            comment: comment || '',
          })
        } catch (dbError) {
          console.warn('⚠️ Не удалось сохранить сессию в локальную БД:', dbError.message)
        }
      }
      
      return res.json(result)
    } catch (proxyError) {
      activeAnalysisSessions.delete(sessionId)
      
      const status = proxyError.status || 500
      const data = proxyError.data || {
        ok: false,
        code: 'UNKNOWN_ERROR',
        message: 'Произошла неизвестная ошибка при анализе',
      }
      
      return res.status(status).json(data)
    }
  }

  // Без ikap2 анализ выписок не выполняется (локальный путь удалён)
  return res.status(503).json({
    ok: false,
    code: 'IKAP2_REQUIRED',
    message: 'Для анализа банковских выписок настройте IKAP2_BACKEND_URL (https://ikap2-backend-latest.onrender.com).',
    sessionId,
  })
})

// Эндпоинт для получения финансового отчета
// Эндпоинт для получения отчета по session_id
app.get('/api/reports/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  
  console.log(`📊 Запрос отчета для сессии: ${sessionId}`)
  
  try {
    // Если используется ikap2, пытаемся получить полный отчет оттуда
    if (USE_IKAP2_FOR_STATEMENTS) {
      try {
        console.log(`🔄 Запрашиваю полный отчет от ikap2 для сессии: ${sessionId}`)
        const ikap2Response = await axios.get(
          `${IKAP2_BACKEND_URL}/api/reports/${sessionId}`,
          {
            headers: {
              'X-External-Service': 'ikap',
            },
            timeout: 30000,
          }
        )
        
        if (ikap2Response.data && ikap2Response.data.ok !== false) {
          // Получили отчет от ikap2
          const ikap2Report = ikap2Response.data
          
          // Локальные поля (налог и фин. отчётность) — не перезатирать данными от ikap2
          const localReport = await db.prepare('SELECT company_bin, amount, term, purpose, name, email, phone, files_count, tax_status, tax_report_text, fs_status, fs_report_text, fs_report_structured, tax_missing_periods, fs_missing_periods FROM reports WHERE session_id = ?').get(sessionId)
          
          try {
            await upsertReport(sessionId, {
              status: ikap2Report.status || 'generating',
              reportText: ikap2Report.report_text || null,
              reportStructured: ikap2Report.report_structured || null,
              filesCount: ikap2Report.files_count ?? localReport?.files_count ?? null,
              filesData: ikap2Report.files_data || null,
              completed: ikap2Report.completed_at || ikap2Report.completed,
              comment: ikap2Report.comment || null,
            })
            console.log(`✅ Отчет от ikap2 сохранен в локальную БД`)
          } catch (dbError) {
            console.warn('⚠️ Не удалось сохранить отчет от ikap2 в локальную БД:', dbError.message)
          }
          
          // Возвращаем отчёт: выписки от ikap2, карточка и налоги/фин — из локальной БД (если есть)
          return res.json({
            ok: true,
            report: {
              sessionId: ikap2Report.session_id || sessionId,
              bin: localReport?.company_bin ?? ikap2Report.company_bin,
              amount: localReport?.amount ?? ikap2Report.amount,
              term: localReport?.term ?? ikap2Report.term,
              purpose: localReport?.purpose ?? ikap2Report.purpose,
              name: localReport?.name ?? ikap2Report.name,
              email: localReport?.email ?? ikap2Report.email,
              phone: localReport?.phone ?? ikap2Report.phone,
              filesCount: localReport?.files_count ?? ikap2Report.files_count,
              status: ikap2Report.status,
              reportText: ikap2Report.report_text,
              reportStructured: ikap2Report.report_structured,
              createdAt: ikap2Report.created_at,
              completedAt: ikap2Report.completed_at || ikap2Report.completed,
              comment: ikap2Report.comment,
              filesData: ikap2Report.files_data,
              taxStatus: localReport?.tax_status,
              taxReportText: localReport?.tax_report_text,
              taxMissing: localReport?.tax_missing_periods,
              fsStatus: localReport?.fs_status,
              fsReportText: localReport?.fs_report_text,
              fsReportStructured: localReport?.fs_report_structured,
              fsMissing: localReport?.fs_missing_periods,
            }
          })
        }
      } catch (ikap2Error) {
        // Если ikap2 вернул ошибку или недоступен, используем локальные данные
        if (ikap2Error.response && ikap2Error.response.status === 404) {
          console.log(`⚠️ Отчет не найден в ikap2 для сессии ${sessionId}, используем локальные данные`)
        } else {
          console.warn(`⚠️ Ошибка запроса отчета от ikap2: ${ikap2Error.message}, используем локальные данные`)
        }
        // Продолжаем с локальной БД ниже
      }
    }
    
    // Fallback: локальные данные из БД (если ikap2 недоступен или отчёт ещё не подтянут)
    const report = await db.prepare('SELECT * FROM reports WHERE session_id = ?').get(sessionId)
    
    if (!report) {
      console.log(`⚠️ Отчет не найден для сессии ${sessionId}`)
      return res.json({
        ok: false,
        message: 'Заявка не найдена'
      })
    }
    
    // Форматируем report_text если это JSON
    const formattedReport = transactionProcessor.ensureHumanReadableReportText({ ...report })
    
    console.log(`✅ Отчет найден, статус: ${formattedReport.status}`)
    return res.json({
      ok: true,
      report: {
        sessionId: formattedReport.session_id,
        bin: formattedReport.company_bin,
        amount: formattedReport.amount,
        term: formattedReport.term,
        purpose: formattedReport.purpose,
        name: formattedReport.name,
        email: formattedReport.email,
        phone: formattedReport.phone,
        filesCount: formattedReport.files_count,
        status: formattedReport.status,
        reportText: formattedReport.report_text,
        reportStructured: formattedReport.report_structured,
        createdAt: formattedReport.created_at,
        completedAt: formattedReport.completed_at,
        // Новые поля аналитов
        taxStatus: formattedReport.tax_status,
        taxReportText: formattedReport.tax_report_text,
        taxMissing: formattedReport.tax_missing_periods,
        fsStatus: formattedReport.fs_status,
        fsReportText: formattedReport.fs_report_text,
        fsReportStructured: formattedReport.fs_report_structured,
        fsMissing: formattedReport.fs_missing_periods,
        openaiResponseId: formattedReport.openai_response_id,
        openaiStatus: formattedReport.openai_status,
      }
    })
  } catch (error) {
    console.error('❌ Ошибка получения отчета:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера'
    })
  }
})

// Эндпоинт для удаления заявки
app.delete('/api/reports/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  console.log(`🗑️ [${new Date().toISOString()}] DELETE запрос на удаление заявки: ${sessionId}`)
  console.log(`🗑️ Request method: ${req.method}, URL: ${req.url}`)
  
  try {
    // Удаляем заявку из БД (каскадно удалятся связанные данные, если настроены внешние ключи)
    // Но лучше удалить явно все связанные данные
    
    // 1. Удаляем сообщения
    try {
      const deleteMessages = db.prepare('DELETE FROM messages WHERE session_id = ?')
      await deleteMessages.run(sessionId)
      console.log(`🗑️ Сообщения удалены для сессии: ${sessionId}`)
    } catch (error) {
      console.error(`⚠️ Ошибка удаления сообщений:`, error.message)
    }
    
    // 2. Удаляем файлы
    try {
      const deleteFiles = db.prepare('DELETE FROM files WHERE session_id = ?')
      await deleteFiles.run(sessionId)
      console.log(`🗑️ Файлы удалены для сессии: ${sessionId}`)
    } catch (error) {
      console.error(`⚠️ Ошибка удаления файлов:`, error.message)
    }
    
    // 3. Удаляем заявку
    try {
      const deleteReport = db.prepare('DELETE FROM reports WHERE session_id = ?')
      await deleteReport.run(sessionId)
      console.log(`🗑️ Заявка удалена для сессии: ${sessionId}`)
    } catch (error) {
      console.error(`⚠️ Ошибка удаления заявки:`, error.message)
      return res.status(500).json({
        ok: false,
        message: 'Ошибка удаления заявки'
      })
    }
    
    // 4. Очищаем данные из памяти
    if (conversationHistory.has(sessionId)) {
      conversationHistory.delete(sessionId)
      console.log(`🗑️ История удалена из памяти для сессии: ${sessionId}`)
    }
    
    if (sessionFiles.has(sessionId)) {
      sessionFiles.delete(sessionId)
      console.log(`🗑️ Файлы удалены из памяти для сессии: ${sessionId}`)
    }
    
    return res.json({
      ok: true,
      message: 'Заявка успешно удалена'
    })
  } catch (error) {
    console.error('❌ Ошибка удаления заявки:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера при удалении заявки'
    })
  }
})

// Эндпоинт для восстановления истории сессии
app.get('/api/sessions/:sessionId/history', async (req, res) => {
  const { sessionId } = req.params
  console.log(`📖 Запрос истории сессии: ${sessionId}`)
  
  try {
    // Получаем историю из БД
    const history = await getMessagesFromDB(sessionId)
    
    if (!history || history.length === 0) {
      console.log(`⚠️ История не найдена в БД для сессии: ${sessionId}`)
      return res.status(404).json({
        ok: false,
        message: 'Сессия не найдена'
      })
    }
    
    // Преобразуем историю в формат сообщений для фронтенда
    const messages = []
    
    // Добавляем приветственное сообщение
    messages.push({
      id: 1,
      text: "Здравствуйте, как я могу к Вам обращаться?",
      sender: 'bot',
      timestamp: new Date()
    })
    
    // Преобразуем историю из БД
    history.forEach((item, index) => {
      if (item.role === 'user') {
        let text = ''
        if (typeof item.content === 'string') {
          text = item.content
        } else if (Array.isArray(item.content)) {
          text = item.content.map(c => c.text || '').join(' ')
        }
        
        messages.push({
          id: Date.now() + index * 2,
          text: text,
          sender: 'user',
          timestamp: new Date()
        })
      } else if (item.role === 'assistant') {
        let text = ''
        if (typeof item.content === 'string') {
          text = item.content
        } else if (Array.isArray(item.content)) {
          text = item.content.map(c => c.text || '').join(' ')
        }
        
        if (text) {
          messages.push({
            id: Date.now() + index * 2 + 1,
            text: text,
            sender: 'bot',
            timestamp: new Date()
          })
        }
      }
    })
    
    console.log(`✅ История восстановлена из БД: ${messages.length} сообщений`)
    return res.json({
      ok: true,
      messages: messages
    })
  } catch (error) {
    console.error('❌ Ошибка восстановления истории:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера'
    })
  }
})

// Эндпоинт для получения файлов сессии
app.get('/api/sessions/:sessionId/files', async (req, res) => {
  const { sessionId } = req.params
  
  try {
    const getFiles = db.prepare(`
      SELECT file_id, original_name, file_size, mime_type, category, uploaded_at
      FROM files 
      WHERE session_id = ? 
      ORDER BY uploaded_at ASC
    `)
    const files = await getFiles.all(sessionId)
    
    console.log(`✅ Найдено файлов для сессии ${sessionId}: ${files.length}`)
    return res.json({
      ok: true,
      files: files.map(f => ({
        fileId: f.file_id,
        originalName: normalizeFileName(f.original_name),
        fileSize: f.file_size,
        mimeType: f.mime_type,
        category: f.category,
        uploadedAt: f.uploaded_at
      }))
    })
  } catch (error) {
    console.error('❌ Ошибка получения файлов:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера'
    })
  }
})

// Эндпоинт для скачивания файла из локального хранилища
app.get('/api/files/:fileId/download', async (req, res) => {
  const { fileId } = req.params
  console.log(`📥 Запрос скачивания файла: ${fileId}`)
  
  try {
    // Получаем файл из БД (включая file_data)
    const getFile = db.prepare(`
      SELECT file_id, original_name, mime_type, file_data
      FROM files 
      WHERE file_id = ?
    `)
    const file = await getFile.get(fileId)
    
    if (!file) {
      console.log(`⚠️ Файл не найден в БД: ${fileId}`)
      return res.status(404).json({
        ok: false,
        message: 'Файл не найден'
      })
    }
    
    // Пытаемся прочитать файл из БД (file_data)
    let buffer = null
    if (file.file_data) {
      try {
        // PostgreSQL BYTEA возвращается как Buffer или строка в hex формате
        if (Buffer.isBuffer(file.file_data)) {
          buffer = file.file_data
        } else if (typeof file.file_data === 'string') {
          // Если это hex строка (начинается с \x)
          if (file.file_data.startsWith('\\x')) {
            buffer = Buffer.from(file.file_data.slice(2), 'hex')
          } else {
            buffer = Buffer.from(file.file_data, 'binary')
          }
        } else {
          buffer = Buffer.from(file.file_data)
        }
        console.log(`✅ Файл прочитан из БД: ${file.original_name} (${buffer.length} bytes)`)
      } catch (readError) {
        console.error(`⚠️ Ошибка чтения файла из БД:`, readError.message)
      }
    }

    if (!buffer) {
      return res.status(404).json({
        ok: false,
        message: 'Файл не найден в БД'
      })
    }
    
    // Устанавливаем заголовки для скачивания
    const downloadName = normalizeFileName(file.original_name) || 'file.pdf'
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(downloadName)}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    )
    res.setHeader('Content-Length', buffer.length)
    
    console.log(`✅ Файл ${fileId} отправлен клиенту`)
    res.send(buffer)
  } catch (error) {
    console.error('❌ Ошибка скачивания файла:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера при скачивании файла'
    })
  }
})

// Эндпоинт для получения списка всех заявок (для менеджера)
app.get('/api/reports', async (req, res) => {
  try {
    const reports = await db.prepare(`
      SELECT session_id, company_bin, amount, term, purpose, name, email, phone, 
             status, files_count, created_at, completed_at,
             tax_status, fs_status, report_text, report_structured,
             openai_response_id, openai_status, tax_report_text, fs_report_text, fs_report_structured,
             tax_missing_periods, fs_missing_periods
      FROM reports 
      ORDER BY created_at DESC
      LIMIT 100
    `).all()
    
    // Форматируем каждый отчет
    const formattedReports = reports.map(r => transactionProcessor.ensureHumanReadableReportText({ ...r }))
    
    console.log(`📋 Получен список заявок: ${formattedReports.length} шт.`)
    return res.json({
      ok: true,
      reports: formattedReports.map(r => ({
        sessionId: r.session_id,
        bin: r.company_bin,
        amount: r.amount,
        term: r.term,
        purpose: r.purpose,
        name: r.name,
        email: r.email,
        phone: r.phone,
        filesCount: r.files_count,
        status: r.status,
        taxStatus: r.tax_status,
        fsStatus: r.fs_status,
        reportText: r.report_text,
        reportStructured: r.report_structured,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        openaiResponseId: r.openai_response_id,
        openaiStatus: r.openai_status,
        taxReportText: r.tax_report_text,
        fsReportText: r.fs_report_text,
        fsReportStructured: r.fs_report_structured,
        taxMissing: r.tax_missing_periods,
        fsMissing: r.fs_missing_periods,
      }))
    })
  } catch (error) {
    console.error('❌ Ошибка получения списка заявок:', error)
    return res.status(500).json({
      ok: false,
      message: 'Не удалось получить отчёты.'
    })
  }
})

// API endpoints для работы с MCP сервером (код из БД)
// Поддерживаем как полное название, так и slug (information-agent)
// ВАЖНО: Эти маршруты должны быть определены ПЕРЕД /api/agent-settings/:agentName
// чтобы Express правильно сопоставил более специфичные маршруты
app.get('/api/agent-settings/:agentName/mcp-server', async (req, res) => {
  try {
    // Получаем agentName из URL (может быть slug или полное название)
    let agentName = req.params.agentName
    
    console.log(`🔍 [MCP Route] Получен запрос, agentName из params: "${agentName}"`)
    console.log(`🔍 [MCP Route] Полный URL: ${req.originalUrl || req.url}`)
    
    // Пробуем декодировать, если не получается - используем как есть
    try {
      agentName = decodeURIComponent(agentName)
    } catch (e) {
      console.warn('⚠️ Не удалось декодировать agentName, используем как есть:', agentName)
    }
    
    // Преобразуем slug обратно в полное название, если нужно
    if (agentName === 'information-agent') {
      agentName = 'Information Agent'
    }
    
    console.log(`📄 Запрос кода MCP сервера для агента: "${agentName}"`)
    
    // Пока поддерживаем только Information Agent
    if (agentName !== 'Information Agent') {
      return res.status(404).json({
        ok: false,
        message: 'MCP сервер доступен только для Information Agent'
      })
    }
    
    // Получаем код из БД
    const settings = await getAgentSettings(agentName)
    
    if (!settings || !settings.mcp_server_code) {
      // Если кода нет в БД, пробуем загрузить из файла (для обратной совместимости)
      const fallbackPath = path.join(__dirname, 'mcp', 'ikap-info-server.js')
      if (fs.existsSync(fallbackPath)) {
        console.log('📄 Загружаем MCP сервер из файла (код в БД отсутствует)')
        const mcpServerContent = fs.readFileSync(fallbackPath, 'utf8')
        return res.json({
          ok: true,
          content: mcpServerContent,
          filename: 'ikap-info-server.js'
        })
      }
      return res.status(404).json({
        ok: false,
        message: 'Код MCP сервера не найден в БД'
      })
    }
    
    console.log(`✅ Код MCP сервера загружен из БД, размер: ${settings.mcp_server_code.length} символов`)
    
    return res.json({
      ok: true,
      content: settings.mcp_server_code,
      filename: 'ikap-info-server.js'
    })
  } catch (error) {
    console.error('❌ Ошибка получения MCP сервера:', error)
    return res.status(500).json({
      ok: false,
      message: `Ошибка сервера при получении MCP сервера: ${error.message}`
    })
  }
})

app.put('/api/agent-settings/:agentName/mcp-server', async (req, res) => {
  try {
    // Получаем agentName из URL (может быть slug или полное название)
    let agentName = req.params.agentName
    
    // Пробуем декодировать, если не получается - используем как есть
    try {
      agentName = decodeURIComponent(agentName)
    } catch (e) {
      console.warn('⚠️ Не удалось декодировать agentName, используем как есть:', agentName)
    }
    
    // Преобразуем slug обратно в полное название, если нужно
    if (agentName === 'information-agent') {
      agentName = 'Information Agent'
    }
    
    const { content } = req.body
    console.log(`💾 Сохранение кода MCP сервера для агента: "${agentName}"`)
    
    // Пока поддерживаем только Information Agent
    if (agentName !== 'Information Agent') {
      return res.status(404).json({
        ok: false,
        message: 'MCP сервер доступен только для Information Agent'
      })
    }
    
    if (!content || typeof content !== 'string') {
      return res.status(400).json({
        ok: false,
        message: 'Поле content обязательно и должно быть строкой'
      })
    }
    
    // Сохраняем код в БД
    const updateMcpCode = db.prepare(`
      UPDATE agent_settings 
      SET mcp_server_code = ?, updated_at = CURRENT_TIMESTAMP
      WHERE agent_name = ?
    `)
    await updateMcpCode.run(content, agentName)
    console.log(`✅ Код MCP сервера сохранен в БД, размер: ${content.length} символов`)
    
    // Перезапускаем MCP сервер с новым кодом
    try {
      if (ikapInfoMcpServer?.close) {
        await ikapInfoMcpServer.close()
      }
      // Удаляем старый временный файл
      if (tempMcpServerPath && fs.existsSync(tempMcpServerPath)) {
        fs.unlinkSync(tempMcpServerPath)
      }
      // Инициализируем заново
      await initMcpServerFromDb()
    } catch (e) {
      console.warn('⚠️ Не удалось перезапустить MCP сервер, будет перезапущен при следующем использовании:', e.message)
    }
    
    // Сбрасываем кэш агента, чтобы он пересоздался с новым MCP сервером
    informationAgent = null
    agentCacheTimestamp = 0
    console.log('🔄 Кэш Information Agent сброшен, MCP сервер обновлен')
    
    return res.json({
      ok: true,
      message: 'Код MCP сервера успешно сохранен в БД'
    })
  } catch (error) {
    console.error('❌ Ошибка сохранения MCP сервера:', error)
    return res.status(500).json({
      ok: false,
      message: `Ошибка сервера при сохранении MCP сервера: ${error.message}`
    })
  }
})

// API endpoints для настроек агента
app.get('/api/agent-settings/:agentName', async (req, res) => {
  const { agentName } = req.params
  console.log(`📋 Запрос настроек агента: ${agentName}`)
  
  try {
    const settings = await getAgentSettings(agentName)
    
    if (!settings) {
      return res.status(404).json({
        ok: false,
        message: 'Настройки агента не найдены'
      })
    }
    
    // Безопасный парсинг JSON полей
    let mcpConfig = null
    if (settings.mcp_config) {
      try {
        if (typeof settings.mcp_config === 'string') {
          mcpConfig = JSON.parse(settings.mcp_config)
        } else if (typeof settings.mcp_config === 'object') {
          mcpConfig = settings.mcp_config
        }
      } catch (e) {
        console.error('⚠️ Ошибка парсинга mcp_config:', e)
      }
    }
    
    let modelSettings = null
    if (settings.model_settings) {
      try {
        if (typeof settings.model_settings === 'string') {
          modelSettings = JSON.parse(settings.model_settings)
        } else if (typeof settings.model_settings === 'object') {
          modelSettings = settings.model_settings
        }
      } catch (e) {
        console.error('⚠️ Ошибка парсинга model_settings:', e)
      }
    }
    
    return res.json({
      ok: true,
      settings: {
        agentName,
        instructions: settings.instructions,
        role: settings.role || 'Информационный консультант',
        functionality: settings.functionality || 'Отвечает на вопросы о платформе iKapitalist',
        mcpConfig,
        mcpServerCode: settings.mcp_server_code || null,
        model: settings.model,
        modelSettings,
        defaultAnnualRate: settings.default_annual_rate || 0.3
      }
    })
  } catch (error) {
    console.error('❌ Ошибка получения настроек агента:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера при получении настроек'
    })
  }
})

app.put('/api/agent-settings/:agentName', async (req, res) => {
  const { agentName } = req.params
  const { instructions, role, functionality, mcpConfig, model, modelSettings, defaultAnnualRate } = req.body
  console.log(`💾 Обновление настроек агента: ${agentName}`)
  
  try {
    // Валидация
    if (!instructions || typeof instructions !== 'string') {
      return res.status(400).json({
        ok: false,
        message: 'Поле instructions обязательно и должно быть строкой'
      })
    }
    
    // Валидация годовой ставки
    let annualRateValue = defaultAnnualRate !== undefined ? parseFloat(defaultAnnualRate) : null
    if (annualRateValue !== null && (isNaN(annualRateValue) || annualRateValue <= 0 || annualRateValue > 1)) {
      return res.status(400).json({
        ok: false,
        message: 'Годовая ставка должна быть числом от 0 до 1 (например, 0.3 для 30%)'
      })
    }
    
    const updateSettings = db.prepare(`
      INSERT INTO agent_settings (agent_name, instructions, role, functionality, mcp_config, model, model_settings, default_annual_rate, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (agent_name) DO UPDATE SET
        instructions = EXCLUDED.instructions,
        role = EXCLUDED.role,
        functionality = EXCLUDED.functionality,
        mcp_config = EXCLUDED.mcp_config,
        model = EXCLUDED.model,
        model_settings = EXCLUDED.model_settings,
        default_annual_rate = COALESCE(EXCLUDED.default_annual_rate, agent_settings.default_annual_rate),
        updated_at = CURRENT_TIMESTAMP
    `)
    
    await updateSettings.run(
      agentName,
      instructions,
      role || null,
      functionality || null,
      mcpConfig ? JSON.stringify(mcpConfig) : null,
      model || 'gpt-5-mini',
      modelSettings ? JSON.stringify(modelSettings) : JSON.stringify({ store: true }),
      annualRateValue
    )
    
    // Сбрасываем кэш агента, чтобы он пересоздался с новыми настройками
    if (agentName === 'Information Agent') {
      informationAgent = null
      agentCacheTimestamp = 0
      console.log('🔄 Кэш Information Agent сброшен, будет пересоздан при следующем использовании')
    }
    
    console.log(`✅ Настройки агента ${agentName} обновлены`)
    return res.json({
      ok: true,
      message: 'Настройки успешно обновлены'
    })
  } catch (error) {
    console.error('❌ Ошибка обновления настроек агента:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера при обновлении настроек'
    })
  }
})

// API endpoints для управления разделами MCP сервера
app.get('/api/mcp-sections', async (req, res) => {
  try {
    const sectionsQuery = db.prepare(`
      SELECT id, section_id, title, content, created_at, updated_at
      FROM mcp_sections
      ORDER BY section_id
    `)
    const sections = await sectionsQuery.all()
    
    return res.json({
      ok: true,
      sections: sections.map(s => ({
        id: s.id,
        sectionId: s.section_id,
        title: s.title,
        content: s.content,
        createdAt: s.created_at,
        updatedAt: s.updated_at
      }))
    })
  } catch (error) {
    console.error('❌ Ошибка получения разделов MCP:', error)
    return res.status(500).json({
      ok: false,
      message: `Ошибка сервера при получении разделов: ${error.message}`
    })
  }
})

app.post('/api/mcp-sections', async (req, res) => {
  try {
    const { title, content } = req.body
    
    if (!title || !content) {
      return res.status(400).json({
        ok: false,
        message: 'Поля title и content обязательны'
      })
    }
    
    // Генерируем section_id из title (транслитерация и нормализация)
    const sectionId = title
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/g, '') // Удаляем спецсимволы
      .replace(/\s+/g, '_') // Пробелы в подчеркивания
      .replace(/_+/g, '_') // Множественные подчеркивания в одно
      .replace(/^_|_$/g, '') // Удаляем подчеркивания в начале и конце
      .substring(0, 50) // Ограничиваем длину
    
    if (!sectionId) {
      return res.status(400).json({
        ok: false,
        message: 'Не удалось сгенерировать section_id из title'
      })
    }
    
    // Проверяем, не существует ли уже раздел с таким section_id
    const checkQuery = db.prepare('SELECT id FROM mcp_sections WHERE section_id = ?')
    const existing = await checkQuery.get(sectionId)
    
    if (existing) {
      return res.status(409).json({
        ok: false,
        message: `Раздел с идентификатором "${sectionId}" уже существует`
      })
    }
    
    // Добавляем раздел
    const insertSection = db.prepare(`
      INSERT INTO mcp_sections (section_id, title, content)
      VALUES (?, ?, ?)
    `)
    await insertSection.run(sectionId, title, content)
    
    console.log(`✅ Добавлен новый раздел MCP: ${sectionId} (${title})`)
    
    // Перегенерируем MCP сервер с новым разделом
    try {
      // Закрываем старый MCP сервер
      if (ikapInfoMcpServer?.close) {
        await ikapInfoMcpServer.close()
      }
      // Удаляем старый временный файл
      if (tempMcpServerPath && fs.existsSync(tempMcpServerPath)) {
        fs.unlinkSync(tempMcpServerPath)
      }
      // Инициализируем заново
      await initMcpServerFromDb()
      // Сбрасываем кэш агента
      informationAgent = null
      agentCacheTimestamp = 0
      console.log('🔄 MCP сервер перезапущен с новым разделом')
    } catch (e) {
      console.warn('⚠️ Не удалось перезапустить MCP сервер:', e.message)
    }
    
    return res.json({
      ok: true,
      message: 'Раздел успешно добавлен',
      section: {
        sectionId,
        title,
        content
      }
    })
  } catch (error) {
    console.error('❌ Ошибка добавления раздела MCP:', error)
    return res.status(500).json({
      ok: false,
      message: `Ошибка сервера при добавлении раздела: ${error.message}`
    })
  }
})

app.delete('/api/mcp-sections/:sectionId', async (req, res) => {
  try {
    const { sectionId } = req.params
    
    const deleteSection = db.prepare('DELETE FROM mcp_sections WHERE section_id = ?')
    const result = await deleteSection.run(sectionId)
    
    if (result.changes === 0) {
      return res.status(404).json({
        ok: false,
        message: 'Раздел не найден'
      })
    }
    
    console.log(`✅ Удален раздел MCP: ${sectionId}`)
    
    // Перегенерируем MCP сервер
    try {
      if (ikapInfoMcpServer?.close) {
        await ikapInfoMcpServer.close()
      }
      if (tempMcpServerPath && fs.existsSync(tempMcpServerPath)) {
        fs.unlinkSync(tempMcpServerPath)
      }
      await initMcpServerFromDb()
      informationAgent = null
      agentCacheTimestamp = 0
      console.log('🔄 MCP сервер перезапущен после удаления раздела')
    } catch (e) {
      console.warn('⚠️ Не удалось перезапустить MCP сервер:', e.message)
    }
    
    return res.json({
      ok: true,
      message: 'Раздел успешно удален'
    })
  } catch (error) {
    console.error('❌ Ошибка удаления раздела MCP:', error)
    return res.status(500).json({
      ok: false,
      message: `Ошибка сервера при удалении раздела: ${error.message}`
    })
  }
})

// В production отдаем index.html для всех не-API запросов (SPA routing)
// ВАЖНО: этот маршрут должен быть ПОСЛЕДНИМ, чтобы не перехватывать API запросы
if (process.env.NODE_ENV === 'production') {
  const path = require('path')
  // Обрабатываем только не-API GET запросы. Избегаем '*' (Express 5 path-to-regexp v6).
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'))
  })
}

const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`)
  console.log(`[server] NODE_ENV: ${process.env.NODE_ENV || 'development'}`)
  console.log(`[server] API key present: ${!!process.env.OPENAI_API_KEY}`)
  console.log(`[server] Database: ${process.env.DATABASE_URL ? 'configured' : 'missing'}`)
})

// Keep server alive
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down gracefully')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[server] SIGINT received, shutting down gracefully')
  process.exit(0)
})

