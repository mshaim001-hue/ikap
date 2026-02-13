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
const { runDocumentsOverviewAnalysis } = require('./onepageService')
const { createReportsRouter } = require('./routes/reports')
const { createSessionsRouter } = require('./routes/sessions')
const { createFilesRouter } = require('./routes/files')
const { createAgentSettingsRouter } = require('./routes/agentSettings')
const { createMcpSectionsRouter } = require('./routes/mcpSections')
const { createMcpServerService } = require('./services/mcpServerService')
const { createReportAnalysisService } = require('./services/reportAnalysisService')
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

// onepage: сервис проверки комплектности документов по PNG-обзорам
const ONEPAGE_SERVICE_URL = process.env.ONEPAGE_SERVICE_URL || 'https://onepage-vn9t.onrender.com'
const USE_ONEPAGE_SERVICE = !!ONEPAGE_SERVICE_URL

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

// Функции анализа отчётов (реализация в services/reportAnalysisService), присваиваются после инициализации зависимостей
let runStatementsAnalysis = null
let runTaxAnalysis = null
let runFsAnalysis = null

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
        
        if (report.status === 'generating' && runStatementsAnalysis) {
          console.log(`🔁 Перезапускаем анализ банковских выписок для ${sessionId}`)
          runStatementsAnalysis(sessionId)
        }
        
        if (report.tax_status === 'generating' && runTaxAnalysis) {
          console.log(`🔁 Перезапускаем налоговый анализ для ${sessionId}`)
          runTaxAnalysis(sessionId)
        }
        
        if (report.fs_status === 'generating' && runFsAnalysis) {
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

// MCP сервер: состояние и инициализация через services/mcpServerService (создаётся после db и getAgentSettings)
const mcpState = { ikapInfoMcpServer: null, tempMcpServerPath: null }
let initMcpServerFromDb = null
let initDefaultMcpSections = null

// В production отдаем статические файлы после сборки
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../dist')
  // Основной путь (корень домена)
  app.use(express.static(distPath))
  // Дополнительный префикс /ikap для совместимости со старыми билдами (GitHub Pages base)
  app.use('/ikap', express.static(distPath))
}

// Роуты /api/* подключаются ниже после создания db, getAgentSettings, mcpService и upsertReport

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
        completed_at TIMESTAMP,
        docs_overview_json TEXT,
        docs_overview_text TEXT
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
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS docs_overview_json TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS docs_overview_text TEXT;
      
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

КРИТИЧЕСКИ ВАЖНО — НИКАКИХ ПРИВЕТСТВИЙ:
- НЕ здоровайся с пользователем ("Здравствуйте", "Привет" и т.п.) и НЕ представляйся — интерфейс уже показал приветствие.
- Даже если пользователь пишет "привет", "здравствуйте" или что‑то подобное, НЕ отвечай приветствием, сразу переходи к сути (условия, вопросы по заявке, документы).

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
   7.0. Спроси про режим налогообложения: "Выберите какое налогообложение использует ваша компания:\n\nОбщеустановленный режим (ФНО 100.00 + 200.00 + 300.00)\n\nУпрощенная декларация (ФНО 910.00)\n\nКрестьянские (фермерские) хозяйства (ФНО 920.00)\n\nДругое"
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
- Сначала спроси про режим налогообложения: "Выберите какое налогообложение использует ваша компания:\n\nОбщеустановленный режим (ФНО 100.00 + 200.00 + 300.00)\n\nУпрощенная декларация (ФНО 910.00)\n\nКрестьянские (фермерские) хозяйства (ФНО 920.00)\n\nДругое"
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
6. Только когда пользователь спрашивает про условия, тарифы или комиссии — расскажи о комиссиях платформы (для компаний и инвесторов) и спроси, всё ли понятно. НЕ добавляй блок о комиссиях, если пользователь спросил о другом (контакты, адрес, лицензия, продукты и т.п.).
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
10. Если пользователь спрашивает, что нужно для оформления заявки, какие документы нужны или что требуется для подачи заявки — ответь строго в формате:
   "Для подачи заявки нужны документы.
   Банковские выписки, Налоговые отчеты и Финансовая отчетность — все документы должны быть за текущий и прошлый год (минимум 2 полных года) и в формате PDF.
   Хотите подать заявку — нажмите кнопку ниже."
   Не добавляй сюда другую информацию.
11. В конце, когда интерес подтверждён, предложи начать оформление и передай диалог инвестиционному агенту (сообщи, что он подключится для сбора данных).

ОБЩИЕ ПРАВИЛА:
- Отвечай строго на заданный вопрос. Не добавляй информацию по другим темам (комиссии, продукты, условия и т.д.), если пользователь о них не спрашивал.
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

// MCP сервер: создаём сервис и функции инициализации (используют db и getAgentSettings)
const mcpService = createMcpServerService(db, getAgentSettings, mcpState, __dirname)
initMcpServerFromDb = mcpService.initMcpServerFromDb
initDefaultMcpSections = mcpService.initDefaultMcpSections
setImmediate(async () => {
  await initDefaultMcpSections()
  await initMcpServerFromDb()
})
process.on('exit', () => {
  if (mcpState.ikapInfoMcpServer?.close) {
    mcpState.ikapInfoMcpServer.close().catch((err) => {
      console.error('⚠️ Ошибка закрытия MCP сервера информации:', err)
    })
  }
  if (mcpState.tempMcpServerPath && fs.existsSync(mcpState.tempMcpServerPath)) {
    try {
      fs.unlinkSync(mcpState.tempMcpServerPath)
      console.log('🗑️ Временный файл MCP сервера удален')
    } catch (e) {
      console.warn('⚠️ Не удалось удалить временный файл:', e.message)
    }
  }
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
    mcpServers: mcpState.ikapInfoMcpServer ? [mcpState.ikapInfoMcpServer] : []
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
      mcpServers: mcpState.ikapInfoMcpServer ? [mcpState.ikapInfoMcpServer] : []
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
        setImmediate(() => runStatementsAnalysis(session))
        
        setImmediate(() => runTaxAnalysis(session))

        setImmediate(() => runFsAnalysis(session))
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

// Сервис анализа отчётов (выписки, налоги, фин. отчётность) — используется в /api/agents/run и в resumePendingAnalyses
const reportAnalysis = createReportAnalysisService({
  db,
  getMessagesFromDB,
  normalizeFileName,
  runDocumentsOverviewAnalysis,
  USE_ONEPAGE_SERVICE,
  ONEPAGE_SERVICE_URL,
  runningStatementsSessions,
  sessionFiles,
  USE_IKAP2_FOR_STATEMENTS,
  proxyAnalysisToIkap2,
  upsertReport,
  openaiClient,
  runningTaxSessions,
  parseTaxPdfToText,
  parseTaxPdfsBatchViaHttp,
  runningFsSessions,
  USE_FINANCIAL_PDF_SERVICE,
  analyzeFinancialPdfsViaPdftopng,
})
runStatementsAnalysis = reportAnalysis.runStatementsAnalysis
runTaxAnalysis = reportAnalysis.runTaxAnalysis
runFsAnalysis = reportAnalysis.runFsAnalysis

// Подключаем роуты отчётов, сессий, файлов, настроек агента и разделов MCP (все зависимости уже определены)
const mcpContext = {
  ...mcpState,
  get informationAgent() { return informationAgent },
  set informationAgent(v) { informationAgent = v },
  get agentCacheTimestamp() { return agentCacheTimestamp },
  set agentCacheTimestamp(v) { agentCacheTimestamp = v },
}
app.use('/api/reports', createReportsRouter({ db, USE_IKAP2_FOR_STATEMENTS, IKAP2_BACKEND_URL, upsertReport }))
app.use('/api/sessions', createSessionsRouter({ db, getMessagesFromDB, normalizeFileName }))
app.use('/api/files', createFilesRouter({ db, normalizeFileName }))
app.use('/api/agent-settings', createAgentSettingsRouter({
  db,
  getAgentSettings,
  initMcpServerFromDb,
  mcpContext,
}))
app.use('/api/mcp-sections', createMcpSectionsRouter({
  db,
  initMcpServerFromDb,
  mcpContext,
}))

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
// маршруты /api/reports/:sessionId перенесены в routes/reports.js

// маршрут DELETE /api/reports/:sessionId перенесен в routes/reports.js

// маршруты /api/sessions/* перенесены в routes/sessions.js

// маршруты /api/files/* перенесены в routes/files.js

// маршрут GET /api/reports перенесен в routes/reports.js

// API endpoints для работы с MCP сервером (код из БД)
// Поддерживаем как полное название, так и slug (information-agent)
// Раньше здесь были отдельные маршруты /api/agent-settings/*,
// теперь они перенесены в routes/agentSettings.js

// маршруты /api/mcp-sections/* перенесены в routes/mcpSections.js

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

