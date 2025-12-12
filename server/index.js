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
const { convertPdfsToJson } = require('./pdfConverter')
const transactionProcessor = require('./transactionProcessor')
const { parseTaxPdfToText } = require('./taxPdfParser')
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

/**
 * Логирует, какие данные отправляются в конкретного агента.
 * Чтобы не засорять логи, показываем только последние несколько сообщений и обрезаем текст.
 * @param {string} agentName
 * @param {string} sessionId
 * @param {Array<{role:string, content:any}>} messages
 * @param {object} extra Дополнительная информация (файлы, тип анализа и т.д.)
 */
function logAgentInput(agentName, sessionId, messages = [], extra = {}) {
  try {
    const MAX_MESSAGES = 5
    const MAX_TEXT = 300

    const tail = (messages || []).slice(-MAX_MESSAGES).map((msg, idx) => {
      let text = ''
      if (typeof msg.content === 'string') {
        text = msg.content
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .map((c) => (typeof c === 'string' ? c : (c.text || c.input_text || c.output_text || '')))
          .filter(Boolean)
          .join(' ')
      } else if (msg.content && typeof msg.content.text === 'string') {
        text = msg.content.text
      }
      const preview = text ? text.slice(0, MAX_TEXT).replace(/\s+/g, ' ') : ''
      return {
        index: messages.length - MAX_MESSAGES + idx + 1,
        role: msg.role,
        preview,
      }
    })

    console.log(`🧾 Вход для агента "${agentName}" (session=${sessionId})`, {
      messagesCount: messages?.length || 0,
      lastMessages: tail,
      ...extra,
    })
  } catch (err) {
    console.error('⚠️ Не удалось залогировать вход агента:', err.message)
  }
}

console.log('Loading Agents SDK...')
const { codeInterpreterTool, Agent, Runner, MCPServerStdio } = require('@openai/agents')
const { z } = require('zod')
console.log('Agents SDK loaded successfully')

const app = express()

// Конфигурация Cloud Run OCR сервиса
const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL || ''
const USE_PDF_SERVICE = !!PDF_SERVICE_URL

if (USE_PDF_SERVICE) {
  // Нормализуем URL для логирования (убираем trailing slash)
  const normalizedUrl = PDF_SERVICE_URL.trim().replace(/\/+$/, '')
  console.log(`📡 Cloud Run OCR сервис настроен: ${normalizedUrl}`)
  console.log(`📡 Исходный URL (из env): ${PDF_SERVICE_URL}`)
} else {
  console.log(`⚠️ Cloud Run OCR сервис не настроен (PDF_SERVICE_URL не установлен)`)
}

/**
 * Отправляет один батч PDF файлов на Cloud Run OCR сервис
 * @param {Array<{buffer: Buffer, originalName: string}>} batch - Батч PDF файлов
 * @param {string} serviceUrl - URL сервиса
 * @param {number} timeout - Таймаут в миллисекундах
 * @returns {Promise<Object>} JSON ответ от сервиса
 */
async function sendBatchToOcrService(batch, serviceUrl, timeout) {
  const formData = new FormData()
  
  // Добавляем файлы батча в FormData
  for (const file of batch) {
    if (!file.buffer || !Buffer.isBuffer(file.buffer)) {
      throw new Error(`Файл ${file.originalName} не содержит buffer`)
    }
    formData.append('files', file.buffer, {
      filename: file.originalName,
      contentType: 'application/pdf'
    })
  }

  const batchSize = batch.reduce((sum, f) => sum + f.buffer.length, 0) / 1024 / 1024
  console.log(`📤 Отправляем батч из ${batch.length} файл(ов) (${batchSize.toFixed(2)} MB) на OCR сервис`)

  const response = await axios.post(serviceUrl, formData, {
    headers: {
      ...formData.getHeaders()
    },
    timeout: timeout,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  })

  if (response.status === 200 && response.data) {
    console.log(`✅ Получен JSON ответ для батча из ${batch.length} файл(ов)`)
    return response.data
  } else {
    throw new Error(`Неожиданный ответ от OCR сервиса: статус ${response.status}`)
  }
}

/**
 * Объединяет результаты нескольких батчей в один JSON (как process_multiple_pdfs_to_json в app.py)
 * @param {Array<Object>} batchResults - Массив JSON результатов от каждого батча
 * @returns {Object} Объединенный JSON
 */
function mergeBatchResults(batchResults) {
  if (batchResults.length === 0) {
    throw new Error('Нет результатов для объединения')
  }

  if (batchResults.length === 1) {
    return batchResults[0]
  }

  // Объединяем все страницы и метаданные
  const allPages = []
  const allMetadata = {
    total_files: 0,
    total_pages: 0,
    total_text_blocks: 0,
    files: [],
    average_confidence: 0.0,
    description: 'Объединенный OCR результат нескольких PDF файлов. Используйте structured_table для анализа данных.'
  }

  const allConfidenceScores = []

  for (const result of batchResults) {
    if (result.pages && Array.isArray(result.pages)) {
      allPages.push(...result.pages)
    }

    if (result.metadata) {
      allMetadata.total_files += result.metadata.total_files || 0
      allMetadata.total_pages += result.metadata.total_pages || 0
      allMetadata.total_text_blocks += result.metadata.total_text_blocks || 0
      
      if (result.metadata.files && Array.isArray(result.metadata.files)) {
        allMetadata.files.push(...result.metadata.files)
      }

      if (result.metadata.average_confidence) {
        allConfidenceScores.push(result.metadata.average_confidence)
      }
    }
  }

  // Вычисляем среднюю уверенность
  if (allConfidenceScores.length > 0) {
    allMetadata.average_confidence = allConfidenceScores.reduce((a, b) => a + b, 0) / allConfidenceScores.length
  }

  return {
    pages: allPages,
    metadata: allMetadata
  }
}

/**
 * Отправляет PDF файлы на Cloud Run OCR сервис батчами и получает объединенный JSON ответ
 * Cloud Run имеет лимит ~32MB на запрос, поэтому отправляем по 2-3 файла за раз
 * @param {Array<{buffer: Buffer, originalName: string}>} pdfFiles - Массив PDF файлов с buffer
 * @returns {Promise<Object>} Объединенный JSON ответ от сервиса
 */
async function sendPdfsToOcrService(pdfFiles) {
  if (!USE_PDF_SERVICE) {
    throw new Error('Cloud Run OCR сервис не настроен (PDF_SERVICE_URL не установлен)')
  }

  if (!pdfFiles || pdfFiles.length === 0) {
    throw new Error('Нет файлов для отправки на OCR сервис')
  }

  // Нормализуем URL: убираем все trailing слэши и добавляем один
  const baseUrl = PDF_SERVICE_URL.trim().replace(/\/+$/, '')
  const serviceUrl = `${baseUrl}/process`
  const timeout = 600000 // 10 минут таймаут

  const totalSize = pdfFiles.reduce((sum, f) => sum + f.buffer.length, 0) / 1024 / 1024
  console.log(`📤 Отправляем ${pdfFiles.length} PDF файл(ов) на OCR сервис: ${serviceUrl}`)
  console.log(`📦 Общий размер файлов: ${totalSize.toFixed(2)} MB`)
  console.log(`⏱️ Таймаут запроса: ${timeout / 1000} секунд`)

  // Cloud Run имеет лимит ~32MB на запрос, поэтому разбиваем на батчи
  // Каждый файл ~4-5MB, отправляем по 2 файла за раз (максимум ~10MB на батч)
  const MAX_BATCH_SIZE_MB = 25 // Оставляем запас от лимита 32MB
  const batches = []
  let currentBatch = []
  let currentBatchSize = 0

  for (const file of pdfFiles) {
    const fileSizeMB = file.buffer.length / 1024 / 1024
    
    // Если добавление этого файла превысит лимит, начинаем новый батч
    if (currentBatchSize + fileSizeMB > MAX_BATCH_SIZE_MB && currentBatch.length > 0) {
      batches.push(currentBatch)
      currentBatch = [file]
      currentBatchSize = fileSizeMB
    } else {
      currentBatch.push(file)
      currentBatchSize += fileSizeMB
    }
  }

  // Добавляем последний батч
  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  console.log(`📦 Файлы разбиты на ${batches.length} батч(ей) для обхода лимита Cloud Run (32MB)`)

  try {
    // Отправляем батчи последовательно и собираем результаты
    const batchResults = []
    for (let i = 0; i < batches.length; i++) {
      console.log(`🔄 Обработка батча ${i + 1}/${batches.length}...`)
      try {
        const batchResult = await sendBatchToOcrService(batches[i], serviceUrl, timeout)
        batchResults.push(batchResult)
      } catch (error) {
        if (error.response) {
          const errorMsg = error.response.data?.error || error.response.statusText || 'Неизвестная ошибка'
          console.error(`❌ OCR сервис вернул ошибку для батча ${i + 1} (${error.response.status}): ${errorMsg}`)
          throw new Error(`Ошибка OCR сервиса для батча ${i + 1} (${error.response.status}): ${errorMsg}`)
        } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          console.error(`⏱️ Таймаут запроса к OCR сервису для батча ${i + 1} после ${timeout / 1000} секунд`)
          throw new Error(`OCR сервис не ответил в течение ${timeout / 1000} секунд для батча ${i + 1}.`)
        } else {
          throw error
        }
      }
    }

    // Объединяем результаты всех батчей
    console.log(`🔗 Объединяем результаты ${batchResults.length} батч(ей)...`)
    const mergedResult = mergeBatchResults(batchResults)
    console.log(`✅ Объединенный JSON создан: ${mergedResult.pages?.length || 0} страниц, ${mergedResult.metadata?.total_files || 0} файлов`)
    
    return mergedResult
  } catch (error) {
    if (error.request && !error.response) {
      // Запрос был отправлен, но ответа не получено
      console.error(`❌ OCR сервис не ответил: ${error.message}`)
      console.error(`🔍 Проверьте доступность сервиса: ${baseUrl}/health`)
      throw new Error(`OCR сервис не ответил: ${error.message}. Проверьте доступность сервиса.`)
    } else if (!error.response && !error.request) {
      // Ошибка при настройке запроса
      console.error(`❌ Ошибка при отправке на OCR сервис: ${error.message}`)
      throw new Error(`Ошибка при отправке на OCR сервис: ${error.message}`)
    } else {
      // Ошибка уже обработана выше
      throw error
    }
  }
}

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

// Функция для создания MCP сервера из кода в БД
const initMcpServerFromDb = async () => {
  try {
    const settings = await getAgentSettings('Information Agent')
    let mcpServerCode = settings?.mcp_server_code
    
    // Если кода нет в БД, пробуем загрузить из файла (для обратной совместимости)
    if (!mcpServerCode) {
      const fallbackPath = path.join(__dirname, 'mcp', 'ikap-info-server.js')
      if (fs.existsSync(fallbackPath)) {
        console.log('📄 Загружаем MCP сервер из файла (код в БД отсутствует)')
        mcpServerCode = fs.readFileSync(fallbackPath, 'utf8')
        // Сохраняем в БД для будущего использования
        try {
          const updateMcpCode = db.prepare(`
            UPDATE agent_settings 
            SET mcp_server_code = ? 
            WHERE agent_name = 'Information Agent'
          `)
          await updateMcpCode.run(mcpServerCode)
          console.log('✅ Код MCP сервера сохранен в БД из файла')
        } catch (e) {
          console.warn('⚠️ Не удалось сохранить код MCP сервера в БД:', e.message)
        }
      }
    }
    
    if (!mcpServerCode) {
      console.warn('⚠️ Код MCP сервера не найден ни в БД, ни в файле')
      return null
    }
    
    // Создаем временный файл из кода в БД
    const tempDir = path.join(__dirname, 'mcp', 'temp')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    tempMcpServerPath = path.join(tempDir, 'ikap-info-server.js')
    fs.writeFileSync(tempMcpServerPath, mcpServerCode, 'utf8')
    console.log(`✅ Временный файл MCP сервера создан: ${tempMcpServerPath}`)
    
    // Создаем MCP сервер из временного файла
    ikapInfoMcpServer = new MCPServerStdio({
      command: process.execPath,
      args: [tempMcpServerPath],
      cwd: path.dirname(tempMcpServerPath),
      env: {
        ...process.env
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

// Инициализируем MCP сервер асинхронно после инициализации БД
setImmediate(async () => {
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
  app.use(express.static(path.join(__dirname, '../dist')))
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
      
      -- Создаем индекс для быстрого поиска по agent_name
      CREATE INDEX IF NOT EXISTS idx_agent_settings_name ON agent_settings(agent_name);
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
    `)
  }
  console.log('✅ Database initialized with all tables')
}

initSchema().catch(e => {
  console.error('❌ DB init failed', e)
})

// Проверка и установка Python зависимостей для парсера налоговых PDF
async function checkAndInstallPythonDeps() {
  if (process.env.NODE_ENV !== 'production') {
    // В development пропускаем автоматическую установку
    return
  }
  
  const { spawn } = require('child_process')
  const path = require('path')
  const fs = require('fs')
  
  const taxpdftoPath = process.env.TAX_PDF_TO_PATH || path.join(__dirname, '..', 'taxpdfto')
  const installScriptPath = path.join(taxpdftoPath, 'install_deps.sh')
  
  // Проверяем, существует ли скрипт установки
  if (!fs.existsSync(installScriptPath)) {
    console.log('⚠️ Скрипт установки зависимостей не найден, пропускаем проверку')
    return
  }
  
  // Проверяем, установлен ли pdfplumber
  const pythonExecutable = process.env.PYTHON_PATH || 'python3'
  
  return new Promise((resolve) => {
    const checkProcess = spawn(pythonExecutable, ['-c', 'import pdfplumber; print("OK")'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    
    let stdout = ''
    let stderr = ''
    
    checkProcess.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    
    checkProcess.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    
    checkProcess.on('close', (code) => {
      if (code === 0 && stdout.includes('OK')) {
        console.log('✅ Python зависимости для парсера налоговых PDF установлены')
        resolve()
      } else {
        console.log('⚠️ Python зависимости не найдены, пытаемся установить...')
        
        // Пытаемся установить зависимости
        const installProcess = spawn('bash', [installScriptPath], {
          cwd: taxpdftoPath,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        
        let installStdout = ''
        let installStderr = ''
        
        installProcess.stdout.on('data', (data) => {
          installStdout += data.toString()
          console.log(`[Python deps install] ${data.toString().trim()}`)
        })
        
        installProcess.stderr.on('data', (data) => {
          installStderr += data.toString()
          console.log(`[Python deps install] ${data.toString().trim()}`)
        })
        
        installProcess.on('close', (installCode) => {
          if (installCode === 0) {
            console.log('✅ Python зависимости установлены при старте сервера')
          } else {
            console.warn('⚠️ Не удалось установить Python зависимости при старте, парсинг может не работать')
          }
          resolve()
        })
        
        installProcess.on('error', (error) => {
          console.warn(`⚠️ Ошибка запуска скрипта установки: ${error.message}`)
          resolve()
        })
      }
    })
    
    checkProcess.on('error', (error) => {
      console.warn(`⚠️ Python не найден или недоступен: ${error.message}`)
      resolve()
    })
  })
}

// Запускаем проверку зависимостей асинхронно (не блокируем старт сервера)
setImmediate(() => {
  checkAndInstallPythonDeps().catch(err => {
    console.warn('⚠️ Ошибка при проверке Python зависимостей:', err.message)
  })
})

// SQLite миграции удалены: проект использует только PostgreSQL

// Вспомогательные функции для работы с БД
const saveMessageToDB = async (sessionId, role, content, messageOrder) => {
  try {
    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, role, content, message_order)
      VALUES (?, ?, ?, ?)
    `)
    await insertMessage.run(sessionId, role, JSON.stringify(content), messageOrder)
    console.log(`💾 Сообщение сохранено в БД: ${role} #${messageOrder}`)
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

// Code Interpreter без предустановленных файлов
// Файлы будут добавляться динамически
const codeInterpreter = codeInterpreterTool({
  container: { type: 'auto' }
})

const InvestmentAgentSchema = z.object({
  amount: z.number().nullable().optional(),
  term_months: z.number().nullable().optional(),
  completed: z.boolean().nullable().optional()
})

// Financial Analyst Agent для создания отчета
const financialAnalystAgent = new Agent({
  name: 'Financial Analyst',
  instructions: `Ты финансовый аналитик iKapitalist. Твоя ГЛАВНАЯ ЦЕЛЬ - получить чистую выручку от реализации товаров и услуг за последние 12 месяцев, с учётом всех валютных счетов, и убедиться, соответствует ли компания требованиям платформы (оборот менее 60 млн тенге за 12 месяцев).

📊 **РЕЗЮМЕ ЗАЯВКИ**
- Компания: [БИН]
- Запрашиваемая сумма: [сумма] KZT
- Срок: [месяцев]
- Цель: [цель финансирования]
- Контакты: [имя, фамилия, email, телефон]

🎯 **ОСНОВНЫЕ НАПРАВЛЕНИЯ РАБОТЫ**

1. 💰 **ВЫЯВЛЕНИЕ ОБОРОТОВ ПО РЕАЛИЗАЦИИ**
   Цель: Определить реальные поступления от продажи товаров и услуг.
   
   Что нужно сделать:
   - Из всех банковских выписок (тенговых, долларовых, рублёвых, евро-счетов) выделить операции, которые являются оплатой от клиентов за товары или услуги
   - Убедиться, что эти операции — реальная выручка, а не внутренние переводы или кредиты
   - Идентифицировать операции по реализации по характерным признакам (назначение платежа, контрагенты, регулярность)

2. 🚫 **ИСКЛЮЧЕНИЕ НЕРЕЛЕВАНТНЫХ ОПЕРАЦИЙ**
   Цель: Очистить данные, чтобы осталась только "чистая реализация".
   
   Убрать:
   - Возвраты товаров и услуг (обратные платежи клиентам)
   - Займы, кредиты, пополнения, переводы между своими счетами
   - Ошибочные зачисления
   - Любые поступления, не связанные с продажей
   - Внутренние переводы между счетами компании

3. 💱 **УЧЁТ ВАЛЮТНЫХ СЧЕТОВ**
   Цель: Корректно включить валютную выручку в общую сумму.
   
   Что нужно сделать:
   - По каждому валютному счёту определить поступления (USD, EUR, RUB и т.д.)
   - Конвертировать поступления в тенге по курсу на дату поступления (курс можно брать из данных банка или официального НБ РК)
   - НЕ учитывать внутренние переводы между валютными и тенговыми счетами (чтобы не задвоить выручку)
   - Если часть валюты отправляется поставщику напрямую — эти суммы не считать выручкой (так как они не доходят до компании в тенге)

4. 📅 **ГРУППИРОВКА ПО МЕСЯЦАМ**
   Цель: Посмотреть динамику продаж во времени.
   
   Что нужно сделать:
   - ПРОАНАЛИЗИРУЙ ВСЕ выписки: они могут быть как от одного так и от нескольких казахстанских банков.
   - ОБЪЕДИНИ данные из всех выписок для создания непрерывного периода за последние 12 месяцев
   - Сгруппировать чистые поступления (в пересчёте в тенге) по месяцам за последние 12 месяцев
   - Рассчитать итоговую сумму реализации за период
   - Создать таблицу динамики по месяцам
   - ВАЖНО: Убедись, что ты используешь данные за 12 месяцев, даже если они из разных выписок

5. 📈 **ФОРМИРОВАНИЕ СВОДНОГО АНАЛИЗА**
   Цель: Подготовить понятный итог для отчёта или проверки.
   
   Что нужно сделать:
   - Сделать сводную таблицу с колонками:
     * Месяц
     * Реализация (тенге + валютные счета в пересчёте)
     * Возвраты
     * Чистая реализация
   - По желанию добавить график (динамика по месяцам)

6. ⚖️ **СРАВНЕНИЕ С ТРЕБОВАНИЯМИ ПЛАТФОРМЫ**
   Цель: Проверить соответствие лимиту.
   
   Что нужно сделать:
   - Сравнить общую чистую реализацию за 12 месяцев с порогом 60 млн тенге
   - Если меньше — компания НЕ соответствует требованиям платформы
   - Если больше или равна — компания соответствует требованиям

📋 **СТРУКТУРА ОТЧЕТА**

**АНАЛИЗ ПО БАНКАМ:**
Для каждого банка:
- Название банка и период(ы) выписки
- Выявленные операции по реализации (сумма в тенге)
- Исключённые операции (с обоснованием)
- Чистая выручка по банку (с учётом всех выписок этого банка)

**СВОДНЫЙ АНАЛИЗ:**
- Общая чистая выручка за 12 месяцев: [сумма] KZT
- Динамика по месяцам (таблица)
- Соответствие требованиям платформы: ✅/❌

**РЕКОМЕНДАЦИЯ:**
- ✅ СООТВЕТСТВУЕТ требованиям (выручка ≥ 60 млн KZT)
- ❌ НЕ СООТВЕТСТВУЕТ требованиям (выручка < 60 млн KZT)

---

ВАЖНО:
- Используй Code Interpreter для анализа всех файлов
- Банковские выписки могут быть очень большими (100+ страниц) - ОБЯЗАТЕЛЬНО прочитай ВЕСЬ файл целиком, все страницы!
- Не ограничивайся первыми страницами - используй инструменты для чтения всего PDF файла
- Если файл большой, обработай его по частям, но проанализируй ВСЕ данные из ВСЕХ страниц
- Проверь самую раннюю и самую позднюю дату операций в файле - убедись, что покрыт полный период
- Все суммы указывай в KZT с разделителями тысяч
- Будь точным с датами и периодами
- При объединении данных из разных выписок убедись, что нет дублирования операций
- Проверь, что покрыты полные 12 месяцев (может потребоваться использовать данные из разных выписок)
- Выдели ключевые моменты жирным шрифтом
- Используй эмодзи для визуальной структуры
- ФОКУСИРУЙСЯ на чистой выручке от реализации, а не на общих оборотах`,
  model: 'gpt-5',
  tools: [codeInterpreter],
  modelSettings: { store: true }
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
   7.1. Попроси загрузить НАЛОГОВУЮ отчетность за текущий и предыдущий год в формате PDF. Четко укажи: формат PDF.
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
- Сначала попроси: "Пожалуйста, предоставьте налоговую отчетность за текущий и предыдущий год в формате PDF"

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
      SELECT instructions, mcp_config, model, model_settings, mcp_server_code
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

// Функция для инициализации настроек по умолчанию
const initDefaultAgentSettings = async () => {
  try {
    const defaultInstructions = `Ты информационный агент краудфандинговой платформы iKapitalist.

Твоя цель — через короткий диалог помочь человеку понять возможности платформы и мягко подвести к подаче заявки, чтобы затем подключить инвестиционного агента. Общайся на русском языке, поддерживай живой диалог вопрос–ответ и опирайся на данные MCP.

СТРУКТУРА ДИАЛОГА:
1. Приветствие + уточнение цели: спроси, что именно хочет узнать собеседник (условия, расчёт займа, график платежей, контакты и т.п.). Предложи варианты меню.
2. После ответа давай только релевантную информацию (1–2 факта) и сразу уточняй, нужно ли продолжить или перейти к следующему пункту.
3. При вопросах об условиях, лицензии, рисках, продуктах — запрашивай соответствующие разделы через \`ikapitalist_get_section\` и пересказывай кратко (до 3 предложений), всегда со ссылкой на источник.
4. Отдельным коротким сообщением расскажи о комиссиях платформы (для компаний и инвесторов) и спроси, всё ли понятно.
5. Когда разговор касается финансирования, перечисли четыре вида займов (проценты ежемесячно, аннуитет, равные доли, всё в конце) и попроси выбрать интересующий формат.
6. Если клиент хочет расчёт, уточни сумму, срок, ставку, затем вызови \`ikapitalist_calculate_loan_schedule\`, озвучь ключевые цифры и спроси о следующем шаге.
7. Если клиент запрашивает контакты, адрес или другие детали, используй MCP-ресурсы и ответь кратко, уточнив, нужна ли ещё информация.
8. В конце, когда интерес подтверждён, предложи начать оформление и передай диалог инвестиционному агенту (сообщи, что он подключится для сбора данных).

ОБЩИЕ ПРАВИЛА:
- Каждое сообщение — максимум 3 коротких предложения или 3 пункта. Избегай длинных блоков текста.
- Всегда заканчивай сообщение вопросом или предложением следующего шага.
- Не придумывай фактов; приводи цифры строго из MCP. Если данных нет, так и скажи.
- Если пользователь отклоняет подачу заявки, уважай решение и предложи вернуться позже.`

    const insertSettings = db.prepare(`
      INSERT INTO agent_settings (agent_name, instructions, role, functionality, model, model_settings)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_name) DO NOTHING
    `)
    await insertSettings.run(
      'Information Agent',
      defaultInstructions,
      'Информационный консультант',
      'Отвечает на вопросы о платформе iKapitalist, помогает пользователям понять возможности платформы и подводит к подаче заявки',
      'gpt-5-mini',
      JSON.stringify({ store: true })
    )
    console.log('✅ Настройки по умолчанию для Information Agent инициализированы')
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
  const instructions = settings?.instructions || `Ты информационный агент краудфандинговой платформы iKapitalist.

Твоя цель — через короткий диалог помочь человеку понять возможности платформы и мягко подвести к подаче заявки, чтобы затем подключить инвестиционного агента. Общайся на русском языке, поддерживай живой диалог вопрос–ответ и опирайся на данные MCP.`
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
    logAgentInput(agentName, session, history, {
      filesInSession: (sessionFiles.get(session) || []).map(f => ({
        name: f.originalName,
        size: f.size,
        mime: f.mimetype,
      })),
    })
      
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
        if (role === 'assistant' || role === 'user') {
          try {
            await saveMessageToDB(session, role, item.content, messageOrder)
          } catch (dbError) {
            // Если БД недоступна, логируем но продолжаем работу
            if (dbError.code === 'XX000' || dbError.message?.includes('db_termination') || dbError.message?.includes('shutdown')) {
              console.error(`⚠️ БД соединение разорвано при сохранении сообщения агента. Продолжаем работу без сохранения в БД.`)
            } else {
              console.error(`⚠️ Ошибка сохранения сообщения агента в БД (продолжаем работу):`, dbError.message)
            }
            // Продолжаем работу даже если БД недоступна
          }
        } else {
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
            
            // Сохраняем заявку в БД со статусом "generating"
            const filesData = JSON.stringify(statementFiles)
            const insertReport = db.prepare(`
              INSERT INTO reports (session_id, company_bin, amount, term, purpose, name, email, phone, files_count, files_data, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating')
              ON CONFLICT (session_id) DO UPDATE SET
                company_bin = EXCLUDED.company_bin,
                amount = EXCLUDED.amount,
                term = EXCLUDED.term,
                purpose = EXCLUDED.purpose,
                name = EXCLUDED.name,
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                files_count = EXCLUDED.files_count,
                files_data = EXCLUDED.files_data
                -- НЕ обновляем status если он уже completed
            `)
            await insertReport.run(session, bin, amount, termMonths, purpose, name, email, phone, statementFiles.length, filesData)
            console.log(`💾 Заявка сохранена в БД: ${session}, выписок: ${statementFiles.length}`)
            
            // НОВЫЙ МЕТОД: Обрабатываем выписки через новый метод (конвертация -> классификация -> отчет)
            try {
              // Получаем файлы из sessionFiles (где сохранены buffer'ы)
              const downloadedFiles = []
              const sessionFilesData = sessionFiles.get(session) || []
              
              for (const file of statementFiles) {
                const sessionFile = sessionFilesData.find(f => f.fileId === file.fileId)
                if (sessionFile && sessionFile.buffer) {
                  downloadedFiles.push({
                    buffer: sessionFile.buffer,
                    originalname: file.originalName,
                    mimetype: sessionFile.mimetype || 'application/pdf',
                    size: sessionFile.size || sessionFile.buffer.length
                  })
                }
              }
              
              if (downloadedFiles.length === 0) {
                throw new Error('Не удалось найти ни один файл в памяти для обработки')
              }
              
              // Формируем комментарий с данными заявки
              const commentText = `Данные заявки:
              - Компания (БИН): ${bin}
              - Запрашиваемая сумма: ${amount}
              - Срок: ${termMonths} месяцев
              - Цель финансирования: ${purpose}
              - Контакты: ${name}, ${email}, ${phone}`
              
              // Конвертируем PDF в JSON
              const pdfFiles = downloadedFiles.filter(f => f.mimetype === 'application/pdf' || f.originalname.toLowerCase().endsWith('.pdf'))
              
              if (pdfFiles.length > 0) {
                const pdfDataForConversion = pdfFiles.map(file => ({
                  buffer: file.buffer,
                  filename: file.originalname
                }))
                
                const jsonResults = await convertPdfsToJson(pdfDataForConversion)
                
                // Объединяем все транзакции из всех файлов
                const allTransactions = []
                const allMetadata = []
                
                for (const result of jsonResults) {
                  if (result.error) {
                    console.warn(`⚠️ Ошибка при конвертации файла ${result.source_file}: ${result.error}`)
                    continue
                  }
                  
                  if (result.transactions && Array.isArray(result.transactions)) {
                    allTransactions.push(...result.transactions)
                  }
                  
                  if (result.metadata) {
                    allMetadata.push(result.metadata)
                  }
                }
                
                console.log(`📊 Итого собрано транзакций: ${allTransactions.length}`)
                
                const transactionsWithInternalIds = transactionProcessor.attachInternalTransactionIds(allTransactions, session)
                
                // Классифицируем транзакции
                const { obviousRevenue, obviousNonRevenue, needsReview } = transactionProcessor.splitTransactionsByConfidence(transactionsWithInternalIds)
                
                console.log('🧮 Классификация транзакций:', {
                  total: transactionsWithInternalIds.length,
                  autoRevenue: obviousRevenue.length,
                  autoNonRevenue: obviousNonRevenue.length,
                  needsReview: needsReview.length,
                })
                
                // Если есть транзакции для проверки агентом, запускаем классификатор
                let reviewedRevenue = []
                let reviewedNonRevenue = []
                
                if (needsReview.length > 0) {
                  console.log(`🤖 Запускаем классификатор для ${needsReview.length} транзакций...`)
                  if (!analysisRunner) {
                    analysisRunner = new Runner({})
                  }
                  const classifierAgent = createTransactionClassifierAgent()
                  const agentInput = [{
                    role: 'user',
                    content: [{
                      type: 'input_text',
                      text: transactionProcessor.buildClassifierPrompt(needsReview),
                    }],
                  }]
                  
                  const runResult = await analysisRunner.run(classifierAgent, agentInput)
                  
                  let finalOutputText = ''
                  if (typeof runResult.finalOutput === 'string') {
                    finalOutputText = runResult.finalOutput.trim()
                  } else if (runResult.finalOutput && typeof runResult.finalOutput === 'object' && typeof runResult.finalOutput.text === 'string') {
                    finalOutputText = runResult.finalOutput.text.trim()
                  }
                  
                  if (!finalOutputText) {
                    const rawNewItems = Array.isArray(runResult.newItems)
                      ? runResult.newItems.map((item) => item?.rawItem || item)
                      : []
                    finalOutputText = transactionProcessor.extractAssistantAnswer(rawNewItems) || ''
                  }
                  
                  const classificationEntries = transactionProcessor.parseClassifierResponse(finalOutputText)
                  
                  const decisionsMap = new Map()
                  for (const entry of classificationEntries) {
                    if (!entry || !entry.id) continue
                    const key = String(entry.id)
                    const isRevenue =
                      entry.is_revenue ??
                      entry.isRevenue ??
                      entry.revenue ??
                      (entry.label === 'revenue')
                    decisionsMap.set(key, {
                      isRevenue: Boolean(isRevenue),
                      reason: entry.reason || entry.explanation || '',
                    })
                  }
                  
                  for (const transaction of needsReview) {
                    const decision =
                      decisionsMap.get(String(transaction._ikap_tx_id)) ||
                      decisionsMap.get(transaction._ikap_tx_id)
                    const isRevenue = decision ? decision.isRevenue : false
                    const reason =
                      decision?.reason ||
                      (decision ? '' : 'нет решения от агента, по умолчанию не выручка')
                    
                    const enriched = {
                      ...transaction,
                      _ikap_classification_source: decision ? 'agent' : 'agent_missing',
                      _ikap_classification_reason: reason,
                    }
                    
                    if (isRevenue) {
                      reviewedRevenue.push(enriched)
                    } else {
                      reviewedNonRevenue.push(enriched)
                    }
                  }
                  
                  console.log(`✅ Классификация завершена: ${reviewedRevenue.length} выручка, ${reviewedNonRevenue.length} не выручка`)
                }
                
                // Объединяем транзакции и сортируем по датам
                const finalNonRevenueTransactions = [...obviousNonRevenue, ...reviewedNonRevenue]
                  .sort((a, b) => {
                    const dateA = transactionProcessor.extractTransactionDate(a)
                    const dateB = transactionProcessor.extractTransactionDate(b)
                    if (!dateA && !dateB) return 0
                    if (!dateA) return 1
                    if (!dateB) return -1
                    return dateA.getTime() - dateB.getTime()
                  })
                const finalRevenueTransactions = [...obviousRevenue, ...reviewedRevenue]
                  .sort((a, b) => {
                    const dateA = transactionProcessor.extractTransactionDate(a)
                    const dateB = transactionProcessor.extractTransactionDate(b)
                    if (!dateA && !dateB) return 0
                    if (!dateA) return 1
                    if (!dateB) return -1
                    return dateA.getTime() - dateB.getTime()
                  })
                
                const sortedObviousRevenue = [...obviousRevenue].sort((a, b) => {
                  const dateA = transactionProcessor.extractTransactionDate(a)
                  const dateB = transactionProcessor.extractTransactionDate(b)
                  if (!dateA && !dateB) return 0
                  if (!dateA) return 1
                  if (!dateB) return -1
                  return dateA.getTime() - dateB.getTime()
                })
                
                // Формируем структурированный отчет
                const structuredSummary = transactionProcessor.buildStructuredSummary({
                  revenueTransactions: finalRevenueTransactions,
                  nonRevenueTransactions: finalNonRevenueTransactions,
                  stats: {
                    totalTransactions: transactionsWithInternalIds.length,
                    autoRevenue: obviousRevenue.length,
                    autoNonRevenue: obviousNonRevenue.length,
                    agentReviewed: needsReview.length,
                    agentDecisions: needsReview.length > 0 ? (reviewedRevenue.length + reviewedNonRevenue.length) : 0,
                    unresolved: Math.max(0, needsReview.length - (reviewedRevenue.length + reviewedNonRevenue.length)),
                  },
                  autoRevenuePreview: transactionProcessor.buildTransactionsPreview(sortedObviousRevenue, { limit: 10000 }),
                  convertedExcels: [],
                })
                
                const formattedReportText = transactionProcessor.formatReportAsText(structuredSummary)
                const finalReportPayload = JSON.stringify(structuredSummary, null, 2)
                
                // Сохраняем отчет в БД
                await upsertReport(session, {
                  status: 'completed',
                  reportText: formattedReportText,
                  reportStructured: finalReportPayload,
                  filesCount: statementFiles.length,
                  filesData: JSON.stringify(statementFiles.map(f => ({ name: f.originalName, size: f.size }))),
                  completed: new Date().toISOString(),
                  comment: commentText,
                  openaiResponseId: null,
                  openaiStatus: needsReview.length === 0 ? 'skipped' : (reviewedRevenue.length + reviewedNonRevenue.length > 0 ? 'completed' : 'partial'),
                })
                
                console.log(`✅ Отчет сгенерирован и сохранен в БД для сессии: ${session}`)
                console.log(`📊 Статистика: ${finalRevenueTransactions.length} выручка, ${finalNonRevenueTransactions.length} не выручка`)
              } else {
                throw new Error('Не найдено PDF файлов для обработки')
              }
            } catch (processingError) {
              console.error(`❌ Ошибка обработки выписок новым методом:`, processingError.message)
              console.error(`❌ Стек ошибки:`, processingError.stack)
              
              // Сохраняем ошибку в БД
              const updateError = db.prepare(`
                UPDATE reports 
                SET report_text = ?, status = 'error', completed_at = CURRENT_TIMESTAMP
                WHERE session_id = ?
              `)
              await updateError.run(`Ошибка обработки выписок: ${processingError.message}`, session)
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
              
              // Функция для парсинга одного PDF файла в TXT
              const parseSingleTaxFile = async (file) => {
                console.log(`🔄 Парсим PDF: ${file.originalName}`)
                
                let pdfBuffer = null
                
                // ШАГ 1: Получаем PDF buffer из памяти, локального хранилища или скачиваем
                if (file.buffer && Buffer.isBuffer(file.buffer)) {
                  pdfBuffer = file.buffer
                  console.log(`✅ Используем PDF buffer из памяти (${pdfBuffer.length} bytes)`)
                } else {
                  // Пытаемся прочитать из БД (file_data)
                  let foundInDB = false
                  try {
                    const getFile = db.prepare(`
                      SELECT file_data, file_path FROM files WHERE file_id = ?
                    `)
                    const fileInfo = await getFile.get(file.fileId)
                    if (fileInfo && fileInfo.file_data) {
                      // PostgreSQL BYTEA возвращается как Buffer или строка
                      if (Buffer.isBuffer(fileInfo.file_data)) {
                        pdfBuffer = fileInfo.file_data
                      } else if (typeof fileInfo.file_data === 'string') {
                        // Если это hex строка (начинается с \x)
                        if (fileInfo.file_data.startsWith('\\x')) {
                          pdfBuffer = Buffer.from(fileInfo.file_data.slice(2), 'hex')
                        } else {
                          pdfBuffer = Buffer.from(fileInfo.file_data, 'binary')
                        }
                      } else {
                        pdfBuffer = Buffer.from(fileInfo.file_data)
                      }
                      console.log(`✅ PDF файл прочитан из БД (${pdfBuffer.length} bytes)`)
                      foundInDB = true
                    } else if (fileInfo && fileInfo.file_path) {
                      // Fallback: пытаемся прочитать из файловой системы (для старых файлов)
                      const filePath = path.join(__dirname, fileInfo.file_path)
                      if (fs.existsSync(filePath)) {
                        pdfBuffer = fs.readFileSync(filePath)
                        console.log(`✅ PDF файл прочитан из файловой системы (fallback, ${pdfBuffer.length} bytes)`)
                        foundInDB = true
                      }
                    }
                  } catch (dbError) {
                    console.log(`⚠️ Не удалось прочитать файл из БД:`, dbError.message)
                  }
                  
                  // Если не нашли в БД, скачиваем из OpenAI (только для старых файлов)
                  // Локальные файлы (fileId начинается с "local-") не загружаются в OpenAI
                  if (!foundInDB && !file.fileId.startsWith('local-')) {
                    try {
                      console.log(`📥 Скачиваем PDF файл "${file.originalName}" из OpenAI...`)
                      const pdfFileContent = await openaiClient.files.content(file.fileId)
                      pdfBuffer = Buffer.from(await pdfFileContent.arrayBuffer())
                      console.log(`✅ PDF файл скачан (${pdfBuffer.length} bytes)`)
                    } catch (downloadError) {
                      throw new Error(`Не удалось скачать файл из OpenAI: ${downloadError.message}`)
                    }
                  } else if (!foundInDB && file.fileId.startsWith('local-')) {
                    throw new Error(`Файл не найден в БД для fileId: ${file.fileId}`)
                  }
                }
                
                // ШАГ 2: Парсим PDF в текстовый формат (ОБЯЗАТЕЛЬНО)
                const parsedText = await parseTaxPdfToText(pdfBuffer, file.originalName)
                if (!parsedText || parsedText.trim().length === 0) {
                  throw new Error(`Парсинг PDF вернул пустой текст`)
                }
                
                console.log(`✅ PDF "${file.originalName}" распарсен: ${parsedText.length} символов`)
                
                return {
                  fileName: file.originalName,
                  text: parsedText
                }
              }
              
              // Парсим все PDF файлы параллельно
              const parseResults = await Promise.allSettled(
                taxFiles.map(file => parseSingleTaxFile(file))
              )
              
              // Проверяем результаты парсинга
              const parsedTexts = []
              const parseErrors = []
              
              parseResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                  parsedTexts.push(result.value)
                } else {
                  const file = taxFiles[index]
                  const error = `Ошибка парсинга файла "${file.originalName}": ${result.reason?.message || 'Неизвестная ошибка'}`
                  parseErrors.push(error)
                  console.error(`❌ ${error}`)
                }
              })
              
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

              // ШАГ 3: Бьем распарсенные тексты на батчи, чтобы не превышать лимит по длине промпта
              // По умолчанию используем более мелкий размер батча (~200k символов), чтобы снизить риск таймаутов
              const MAX_TAX_CHARS = Number(process.env.TAX_CHUNK_MAX_CHARS || '200000')
              const batches = []
              let currentBatch = []
              let currentChars = 0

              for (const item of parsedTexts) {
                const len = item.text.length
                // Если добавление файла превышает лимит и в батче уже что-то есть – начинаем новый батч
                if (currentBatch.length > 0 && currentChars + len > MAX_TAX_CHARS) {
                  batches.push({ items: currentBatch, totalChars: currentChars })
                  currentBatch = []
                  currentChars = 0
                }
                currentBatch.push(item)
                currentChars += len
              }
              if (currentBatch.length > 0) {
                batches.push({ items: currentBatch, totalChars: currentChars })
              }

              console.log(`🧩 Налоговые файлы разбиты на ${batches.length} батч(ей) (лимит ~${MAX_TAX_CHARS} символов на батч)`)

              // ШАГ 4–5: Для каждого батча формируем TXT, загружаем в OpenAI и запускаем анализ
              let combinedTaxReport = ''
              const analysisErrors = []

              for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
                const batch = batches[batchIndex]
                const batchFiles = batch.items.map((p) => p.fileName)

                // 4.1 Формируем объединенный текст для батча
                const parts = []
                batch.items.forEach((parsed, idx) => {
                  parts.push(`\n${'='.repeat(80)}\n`)
                  parts.push(`ФАЙЛ ${idx + 1} из ${batch.items.length}: ${parsed.fileName}\n`)
                  parts.push(`${'='.repeat(80)}\n\n`)
                  parts.push(parsed.text)
                  parts.push(`\n\n`)
                })
                const batchText = parts.join('')
                console.log(`✅ Объединенный текст для батча ${batchIndex + 1}/${batches.length} создан: ${batchText.length} символов`)

                // 4.2 Загружаем TXT батча в OpenAI
                const batchFilename = `tax_reports_batch${batchIndex + 1}_${session}.txt`
                let batchFileId = null
                try {
                  const txtFile = await openaiClient.files.create({
                    file: await toFile(Buffer.from(batchText, 'utf-8'), batchFilename, { type: 'text/plain' }),
                    purpose: 'assistants',
                  })
                  batchFileId = txtFile.id
                  console.log(`✅ TXT батча ${batchIndex + 1}/${batches.length} загружен в OpenAI (file_id: ${batchFileId})`)
                } catch (uploadError) {
                  const errorMessage = `Не удалось загрузить TXT батча ${batchIndex + 1}/${batches.length} в OpenAI: ${uploadError.message}`
                  console.error(`❌ ${errorMessage}`)
                  analysisErrors.push(`Батч ${batchIndex + 1}/${batches.length} (${batchFiles.join(', ')}): ${uploadError.message}`)
                  continue
                }

                // 5. Запускаем анализ TXT батча
                const taxRequest = `Сделай анализ налоговой отчетности для всех прикрепленных файлов (батч ${batchIndex + 1} из ${batches.length}).
В файлах могут находиться несколько деклараций (формы 100/200/300/910). 
Пройди весь текст целиком, чтобы не пропустить ни одну форму.

Файлы для анализа в этом батче: ${batchFiles.join(', ')}`

                const analysisTimeout = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(`Tax Analyst timeout (${TAX_TIMEOUT_MS/1000}s)`)), TAX_TIMEOUT_MS)
                )

                try {
                  const taxAgent = new Agent({
                    name: 'Tax Analyst',
                    instructions: `Ты налоговый аналитик. Проанализируй прикрепленный файл налоговой отчетности.
Файл предоставлен в текстовом формате (распарсен из PDF). Используй Code Interpreter, чтобы прочитать и разобрать всё содержимое.

Алгоритм:
1. Просканируй весь файл — в нём может быть несколько деклараций подряд. Для каждого обнаруженного блока определи тип формы (100/200/300/910).
2. Для каждой формы заполни указанные ниже поля. ВАЖНО: Для каждого кода строки (например, "100.00.055") найди строку/абзац в тексте, где упоминается этот код. Извлеки числовое значение, которое находится в той же строке/абзаце рядом с кодом. НЕ ищи числа по всему файлу — только в контексте найденной строки с кодом. Замени "..." на реальное значение из текста. Если в строке с кодом нет числового значения, оставь поле пустым.
3. После перечисления всех форм добавь раздел "Краткий анализ по годам" — сгруппируй выводы по налоговым периодам/годам, отметь динамику, задолженности и заметные изменения.
4. Если в файле отсутствуют требуемые формы, явно укажи это.

Формат вывода:
- Для КАЖДОЙ найденной формы используй отдельный блок:
  *\`Форма 100\`*: 
    БИН: ...
    Налоговый период: ...
    Наименование налогоплательщика: ...
    100.00.015 СОВОКУПНЫЙ ГОДОВОЙ ДОХОД (сумма с 100.00.001 по 100.00.014): ...
    100.00.055 НАЛОГООБЛАГАЕМЫЙ ДОХОД С УЧЕТОМ ПЕРЕНЕСЕННЫХ УБЫТКОВ (100.00.053 - 100.00.054): ...
    ВАЖНО: Замени "..." на реальное значение из текста. Например, если в тексте есть строка "100.00.055 НАЛОГООБЛАГАЕМЫЙ ДОХОД С УЧЕТОМ ПЕРЕНЕСЕННЫХ 21302759 УБЫТКОВ", то укажи: 100.00.055 НАЛОГООБЛАГАЕМЫЙ ДОХОД С УЧЕТОМ ПЕРЕНЕСЕННЫХ УБЫТКОВ (100.00.053 - 100.00.054): 21302759

  *\`Форма 300\`*: 
    БИН: ...
    Налоговый период: ...
    Наименование налогоплательщика: ...
    300.00.006 Общий оборот: ...
    300.00.030 Исчисленная сумма НДС за налоговый период:
      I. сумма НДС, подлежащая уплате: ...
      II. Превышение суммы НДС, относимого в зачет, над суммой начисленного налога: ...
    ВАЖНО: Замени "..." на реальное значение из текста. Найди строку с кодом (например, "300.00.006") и извлеки число из той же строки/абзаца.

  *\`Форма 200\`*: 
    БИН: ...
    Налоговый период: ...
    Наименование налогоплательщика: ...
    200.01.001 Итого за отчетный квартал: ...
    Общая численность работников: 3 мес.: ...
    ВАЖНО: Замени "..." на реальное значение из текста. Найди строку с кодом (например, "200.01.001") и извлеки число из той же строки/абзаца.

  *\`Форма 910\`*: 
    БИН: ...
    Налоговый период: ...
    Наименование налогоплательщика: ...
    910.00.001 Доход: ...
    910.00.016 Начисление доходы. Итого за полугодие: ...
    910.00.005 Сумма начисленных налогов: ...
    910.00.003 Среднесписочная численность работников, в том числе: ...
    ВАЖНО: Замени "..." на реальное значение из текста. Найди строку с кодом (например, "910.00.001") и извлеки число из той же строки/абзаца.

5. В конце добавь раздел "Краткий анализ по годам" с выводами по каждому году: итоги доходов/НДС, наличие доначислений или задолженности, существенные отклонения.`,
                    model: 'gpt-5',
                    tools: [codeInterpreterTool({ container: { type: 'auto', file_ids: [batchFileId] } })],
                    modelSettings: { store: true }
                  })
                  const taxRunner = new Runner({})

                  const taxMessages = [{ role: 'user', content: [{ type: 'input_text', text: taxRequest }] }]
                  logAgentInput('Tax Analyst', session, taxMessages, {
                    batchFileId,
                    taxFiles: batchFiles,
                    taxRequestLength: taxRequest.length,
                  })
                  console.log(`⚙️ Запускаем анализ TXT батча ${batchIndex + 1}/${batches.length} (${batchFiles.length} файлов)...`)

                  const result = await Promise.race([
                    taxRunner.run(taxAgent, taxMessages),
                    analysisTimeout,
                  ])

                  // Извлекаем отчет для батча
                  let taxText = ''
                  for (let i = result.newItems.length - 1; i >= 0; i -= 1) {
                    const it = result.newItems[i]
                    if (it.rawItem?.role === 'assistant') {
                      const c = it.rawItem.content
                      if (Array.isArray(c)) {
                        const t = c.find((x) => x?.type === 'text' || x?.type === 'output_text')
                        taxText = (typeof t?.text === 'string') ? t.text : (t?.text?.value || '')
                      } else if (typeof it.rawItem.content === 'string') {
                        taxText = it.rawItem.content
                      }
                      if (taxText) break
                    }
                  }

                  if (!taxText) {
                    taxText = `Анализ налоговой отчетности для батча ${batchIndex + 1}/${batches.length} не удалось извлечь из ответа агента.`
                  }

                  // Добавляем результат батча в общий отчет с разделителем
                  combinedTaxReport += `\n${'='.repeat(80)}\nОТЧЕТ ПО БАТЧУ ${batchIndex + 1} ИЗ ${batches.length}\nФайлы: ${batchFiles.join(', ')}\n${'='.repeat(80)}\n\n`
                  combinedTaxReport += taxText.trim()
                  combinedTaxReport += '\n\n'

                  console.log(`✅ Анализ налоговых файлов для батча ${batchIndex + 1}/${batches.length} завершен`)
                } catch (error) {
                  console.error(`❌ Ошибка анализа налоговых файлов для батча ${batchIndex + 1}/${batches.length}:`, error.message)
                  analysisErrors.push(`Батч ${batchIndex + 1}/${batches.length} (${batchFiles.join(', ')}): ${error.message}`)
                }
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
            
            // Обрабатываем PDF файлы через Cloud Run OCR сервис
            if (pdfFiles.length > 0) {
              if (!USE_PDF_SERVICE) {
                console.error(`❌ Cloud Run OCR сервис не настроен, но найдены PDF файлы финансовой отчетности`)
                // Добавляем ошибки для всех PDF файлов
                pdfFiles.forEach(pdfFile => {
                  fsFileReports.push({
                    fileId: pdfFile.file_id,
                    fileName: pdfFile.normalized_name,
                    report: `Ошибка: Cloud Run OCR сервис не настроен. Установите переменную окружения PDF_SERVICE_URL.`
                  })
                })
              } else {
                console.log(`\n📄 Обрабатываем ${pdfFiles.length} PDF файл(ов) через Cloud Run OCR сервис...`)
                
                try {
                  // Получаем buffer'ы файлов из sessionFiles
                  const sessionFilesData = sessionFiles.get(session) || []
                  const pdfFilesWithBuffers = []
                  
                  for (const pdfFile of pdfFiles) {
                    const sessionFile = sessionFilesData.find(f => f.fileId === pdfFile.file_id)
                    if (sessionFile && sessionFile.buffer) {
                      pdfFilesWithBuffers.push({
                        buffer: sessionFile.buffer,
                        originalName: pdfFile.normalized_name,
                        fileId: pdfFile.file_id
                      })
                    } else {
                      console.warn(`⚠️ Buffer не найден для PDF файла ${pdfFile.normalized_name}, пропускаем`)
                    }
                  }
                  
                  if (pdfFilesWithBuffers.length > 0) {
                  // Отправляем PDF файлы на OCR сервис
                  const ocrJsonData = await sendPdfsToOcrService(pdfFilesWithBuffers)
                  
                  // Создаем временный JSON файл с результатами OCR
                  const jsonFileName = `financial_ocr_${session}_${Date.now()}.json`
                  const jsonBuffer = Buffer.from(JSON.stringify(ocrJsonData, null, 2), 'utf-8')
                  
                  // Загружаем JSON файл в OpenAI
                  const jsonFile = await toFile(jsonBuffer, jsonFileName, { type: 'application/json' })
                  const uploadedJsonFile = await openaiClient.files.create({
                    file: jsonFile,
                    purpose: 'assistants'
                  })
                  
                  console.log(`✅ JSON файл с OCR результатами загружен в OpenAI: ${uploadedJsonFile.id}`)
                  
                  // Анализируем JSON через агента
                  const pdfAnalysisPromises = pdfFilesWithBuffers.map(async (pdfFile) => {
                    const fileStartTime = Date.now()
                    console.log(`\n📄 Анализируем финансовый PDF файл: ${pdfFile.originalName}`)
                    
                    const fsRequest = `Сделай анализ финансовой отчетности для файла "${pdfFile.originalName}".
Данные из файла уже обработаны через OCR и представлены в структурированном JSON формате.
Требования:
- Сфокусируйся на текущем и предыдущем годах
- Если какого-то года нет, явно укажи об этом и сделай анализ по имеющимся данным
- Дай ключевые метрики: выручка, валовая прибыль/маржа, операционная прибыль, чистая прибыль, активы/обязательства
- Выведи краткий вывод о динамике и рисках.
- Используй структурированные таблицы из JSON (structured_table или structured_table_array) для анализа данных.
JSON файл с OCR результатами прикреплен.`
                    
                    const FS_TIMEOUT_MS = 30 * 60 * 1000 // 30 минут
                    const analysisTimeout = new Promise((_, reject) =>
                      setTimeout(() => reject(new Error(`Financial Statements Analyst timeout для ${pdfFile.originalName} (${FS_TIMEOUT_MS/1000}s)`)), FS_TIMEOUT_MS)
                    )
                    
                    try {
                      const fsAgent = new Agent({
                        name: 'Financial Statements Analyst',
                        instructions: `Ты аналитик финансовой отчетности. Проанализируй Баланс и ОПУ (P&L) используя структурированные данные из JSON файла с OCR результатами.
                        Требования:
                        - Сфокусируйся на текущем и предыдущем годах
                        - Если какого-то года нет, явно укажи об этом и сделай анализ по имеющимся данным
                        - Дай ключевые метрики: выручка, валовая прибыль/маржа, операционная прибыль, чистая прибыль, активы/обязательства
                        - Выведи краткий вывод о динамике и рисках.
                        - Используй структурированные таблицы из JSON (structured_table или structured_table_array) для анализа данных.`,
                        model: 'gpt-5',
                        tools: [codeInterpreterTool({ container: { type: 'auto', file_ids: [uploadedJsonFile.id] } })],
                        modelSettings: { store: true }
                      })
                      const fsRunner = new Runner({})
                      
                      console.log(`⚙️ Запускаем анализ финансового PDF файла "${pdfFile.originalName}"...`)
                      
                      const result = await Promise.race([
                        fsRunner.run(fsAgent, [{ role: 'user', content: [{ type: 'input_text', text: fsRequest }] }]),
                        analysisTimeout
                      ])
                      
                      // Извлекаем отчет
                      let fsText = ''
                      for (let i = result.newItems.length - 1; i >= 0; i--) {
                        const it = result.newItems[i]
                        if (it.rawItem?.role === 'assistant') {
                          const c = it.rawItem.content
                          if (Array.isArray(c)) {
                            const t = c.find(x => x?.type === 'text' || x?.type === 'output_text')
                            fsText = (typeof t?.text === 'string') ? t.text : (t?.text?.value || '')
                          } else if (typeof it.rawItem.content === 'string') {
                            fsText = it.rawItem.content
                          }
                          if (fsText) break
                        }
                      }
                      
                      if (!fsText) {
                        fsText = `Анализ финансовой отчетности для файла "${pdfFile.originalName}" не удалось извлечь из ответа агента.`
                      }
                      
                      const fileAnalysisTime = ((Date.now() - fileStartTime) / 1000).toFixed(2)
                      console.log(`✅ Анализ финансового PDF файла "${pdfFile.originalName}" завершен за ${fileAnalysisTime}s`)
                      
                      return {
                        fileId: pdfFile.fileId,
                        fileName: pdfFile.originalName,
                        report: fsText
                      }
                    } catch (error) {
                      console.error(`❌ Ошибка анализа финансового PDF файла "${pdfFile.originalName}":`, error.message)
                      return {
                        fileId: pdfFile.fileId,
                        fileName: pdfFile.originalName,
                        report: `Ошибка анализа файла "${pdfFile.originalName}": ${error.message}`
                      }
                    }
                  })
                  
                  const pdfResults = await Promise.allSettled(pdfAnalysisPromises)
                  pdfResults.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                      fsFileReports.push(result.value)
                      console.log(`✅ Финансовый PDF отчет ${index + 1}/${pdfFilesWithBuffers.length} готов: ${result.value.fileName}`)
                    } else {
                      const file = pdfFilesWithBuffers[index]
                      fsFileReports.push({
                        fileId: file.fileId,
                        fileName: file.originalName,
                        report: `Ошибка анализа: ${result.reason?.message || 'Неизвестная ошибка'}`
                      })
                      console.error(`❌ Ошибка анализа финансового PDF файла ${file.originalName}:`, result.reason)
                    }
                  })
                  } else {
                    console.warn(`⚠️ Не найдено buffer'ов для PDF файлов, пропускаем обработку через OCR сервис`)
                    // Добавляем ошибки для файлов без buffer
                    pdfFiles.forEach(pdfFile => {
                      const sessionFile = sessionFiles.get(session)?.find(f => f.fileId === pdfFile.file_id)
                      if (!sessionFile || !sessionFile.buffer) {
                        fsFileReports.push({
                          fileId: pdfFile.file_id,
                          fileName: pdfFile.normalized_name,
                          report: `Ошибка: не найден buffer файла для обработки через OCR сервис`
                        })
                      }
                    })
                  }
                } catch (error) {
                  console.error(`❌ Ошибка обработки PDF файлов через OCR сервис:`, error.message)
                  console.error(`❌ Стек ошибки:`, error.stack)
                  // Добавляем ошибки для всех PDF файлов
                  pdfFiles.forEach(pdfFile => {
                    fsFileReports.push({
                      fileId: pdfFile.file_id,
                      fileName: pdfFile.normalized_name,
                      report: `Ошибка обработки через OCR сервис: ${error.message}`
                    })
                  })
                }
              }
            }
            
            // Сохраняем объединенный отчет (только PDF)
            if (fsFileReports.length > 0) {
              let combinedFsReport = fsFileReports.map((fr, idx) => {
                return `\n\n${'='.repeat(80)}\nОТЧЕТ ${idx + 1} из ${fsFileReports.length}\nФайл: ${fr.fileName}\n${'='.repeat(80)}\n\n${fr.report}`
              }).join('\n\n')
              
              if (nonPdfFiles.length > 0) {
                const nonPdfNames = nonPdfFiles.map(f => f.normalized_name).join(', ')
                combinedFsReport += `\n\n⚠️ Файлы некорректного формата (не проанализированы): ${nonPdfNames}. Для автоматического анализа требуется формат PDF.`
              }
              
              // Сохраняем объединенный отчет в БД
              console.log(`💾 Сохраняем ${fsFileReports.length} финансовых отчетов в БД...`)
              await db.prepare(`UPDATE reports SET fs_report_text = ?, fs_status = 'completed' WHERE session_id = ?`).run(combinedFsReport, session)
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
// Конвертация PDF -> фильтрация -> классификация -> суммирование -> вывод

const activeAnalysisSessions = new Set()
let analysisRunner = null

const createTransactionClassifierAgent = () => {
  return new Agent({
    name: 'Revenue Classifier',
    instructions: transactionProcessor.transactionClassifierInstructions,
    model: 'gpt-5.1',
    modelSettings: { store: true },
  })
}

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
  })

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

  if (!comment || comment.length === 0) {
    console.error('❌ Запрос без комментария, возвращаем 400')
    activeAnalysisSessions.delete(sessionId)
    return res.status(400).json({
      ok: false,
      code: 'COMMENT_REQUIRED',
      message: 'Укажите важные данные',
    })
  }

  try {
    conversationHistory.set(sessionId, conversationHistory.get(sessionId) || [])
    const history = conversationHistory.get(sessionId)

    if (comment) {
      history.push({ role: 'user', content: [{ type: 'text', text: comment }] })
      await saveMessageToDB(sessionId, 'user', [{ type: 'text', text: comment }], history.length)
    }

    const attachments = []
    const pdfFiles = []
    const otherFiles = []
    let extractedTransactions = []
    let convertedExcels = []

    // Разделяем файлы на PDF и остальные
    for (const file of files) {
      const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')
      if (isPdf) {
        pdfFiles.push(file)
      } else {
        otherFiles.push(file)
      }
    }

    // Обрабатываем PDF файлы: конвертируем в JSON
    if (pdfFiles.length > 0) {
      console.log(`🔄 Конвертирую ${pdfFiles.length} PDF файл(ов) в JSON...`)
      try {
        const pdfDataForConversion = pdfFiles.map(file => ({
          buffer: file.buffer,
          filename: file.originalname
        }))
        
        const jsonResults = await convertPdfsToJson(pdfDataForConversion)
        console.log(`✅ Конвертация завершена: получено ${jsonResults.length} результат(ов)`)

        // Объединяем все транзакции из всех файлов
        const allTransactions = []
        const allMetadata = []
        const collectedExcels = []
        
        for (const result of jsonResults) {
          if (result.error) {
            console.warn(`⚠️ Ошибка при конвертации файла ${result.source_file}: ${result.error}`)
            continue
          }
          
          if (result.transactions && Array.isArray(result.transactions)) {
            allTransactions.push(...result.transactions)
          }
          
          if (result.metadata) {
            allMetadata.push({
              source_file: result.source_file,
              ...result.metadata
            })
          }

          if (result.excel_file && typeof result.excel_file === 'object' && result.excel_file.base64) {
            try {
              const excelBuffer = Buffer.from(result.excel_file.base64, 'base64')
              collectedExcels.push({
                name: result.excel_file.name || (result.source_file ? result.source_file.replace(/\.pdf$/i, '.xlsx') : 'converted.xlsx'),
                size: result.excel_file.size || excelBuffer.length,
                mime: result.excel_file.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                source: result.source_file,
                base64: result.excel_file.base64,
              })
            } catch (excelError) {
              console.error('⚠️ Не удалось обработать Excel файл из результата конвертации', excelError)
            }
          }
        }
        
        console.log(`📊 Итого собрано транзакций: ${allTransactions.length}`)
        convertedExcels = collectedExcels

        const transactionsWithInternalIds = transactionProcessor.attachInternalTransactionIds(allTransactions, sessionId)
        extractedTransactions = transactionsWithInternalIds

        // Создаем JSON файл с результатами конвертации
        const jsonData = {
          metadata: allMetadata,
          transactions: transactionsWithInternalIds,
          summary: {
            total_files: pdfFiles.length,
            total_transactions: allTransactions.length,
            converted_at: new Date().toISOString()
          }
        }

        const jsonString = JSON.stringify(jsonData, null, 2)
        const jsonBuffer = Buffer.from(jsonString, 'utf-8')
        const jsonFilename = `converted_statements_${Date.now()}.json`

        // Загружаем JSON файл в OpenAI Files API
        let jsonFileId = null
        if (allTransactions.length > 0) {
          try {
            const uploadedJsonFile = await openaiClient.files.create({
              file: await toFile(jsonBuffer, jsonFilename, { type: 'application/json' }),
              purpose: 'assistants',
            })
            
            jsonFileId = uploadedJsonFile.id
            console.log('✅ JSON файл загружен в OpenAI', {
              fileId: jsonFileId,
              filename: uploadedJsonFile.filename,
              size: jsonBuffer.length,
              transactions: allTransactions.length,
            })

            // Сохраняем JSON файл в БД
            try {
              await saveFileToDatabase(jsonBuffer, sessionId, jsonFileId, jsonFilename, 'application/json')
              console.log(`💾 JSON файл сохранен в БД: ${jsonFilename}`)
            } catch (dbError) {
              console.error('⚠️ Не удалось сохранить JSON файл в БД, продолжаем работу', dbError)
            }

            // Обновляем категорию файла
            try {
              await saveFileToDB(
                sessionId,
                jsonFileId,
                jsonFilename,
                jsonBuffer.length,
                'application/json',
                'converted_statement',
                null
              )
            } catch (error) {
              console.error('⚠️ Не удалось обновить категорию JSON файла в БД, продолжаем работу', error)
            }

            attachments.push({
              file_id: jsonFileId,
              original_filename: jsonFilename,
              is_converted: true,
              source_files: pdfFiles.map(f => f.originalname),
              transaction_count: allTransactions.length
            })
          } catch (uploadError) {
            console.error('❌ Ошибка загрузки JSON файла в OpenAI:', uploadError.message)
            if (jsonBuffer.length < 100000) {
              console.warn('⚠️ Используем fallback: вставляем JSON в промпт (файл меньше 100KB)')
              attachments.push({
                is_converted: true,
                source_files: pdfFiles.map(f => f.originalname),
                json_data: jsonString,
                transaction_count: allTransactions.length
              })
            } else {
              throw new Error(`Не удалось загрузить JSON файл (${jsonBuffer.length} bytes) в OpenAI. Файл слишком большой для вставки в промпт.`)
            }
          }
        } else {
          attachments.push({
            is_converted: true,
            source_files: pdfFiles.map(f => f.originalname),
            transaction_count: 0
          })
        }
      } catch (conversionError) {
        console.error('❌ Ошибка конвертации PDF в JSON:', conversionError.message)
        throw new Error(`Не удалось конвертировать PDF файлы: ${conversionError.message}`)
      }
    }

    // Обрабатываем остальные файлы (не PDF)
    for (const file of otherFiles) {

      const uploadedFile = await openaiClient.files.create({
        file: await toFile(file.buffer, file.originalname, { type: file.mimetype }),
        purpose: 'assistants',
      })

      console.log('✅ Файл загружен в OpenAI', {
        fileId: uploadedFile.id,
        filename: uploadedFile.filename,
        purpose: uploadedFile.purpose,
      })

      // Сохраняем файл в БД
      try {
        await saveFileToDatabase(file.buffer, sessionId, uploadedFile.id, file.originalname, file.mimetype)
        console.log(`💾 Файл сохранен в БД: ${file.originalname}`)
      } catch (dbError) {
        console.error('⚠️ Не удалось сохранить файл в БД, продолжаем работу', dbError)
      }

      const category = categorizeUploadedFile(file.originalname, file.mimetype)
      try {
        await saveFileToDB(
          sessionId,
          uploadedFile.id,
          file.originalname,
          file.size,
          file.mimetype,
          category,
          null
        )
      } catch (error) {
        console.error('⚠️ Не удалось обновить категорию файла в БД, продолжаем работу', error)
      }

      attachments.push({
        file_id: uploadedFile.id,
        original_filename: file.originalname,
      })
    }

    const filesDataJson = JSON.stringify(
      files.map((file) => ({
        name: file.originalname,
        size: file.size,
        mime: file.mimetype,
      }))
    )

    try {
      await upsertReport(sessionId, {
        status: 'generating',
        reportText: null,
        reportStructured: null,
        filesCount: files.length,
        filesData: filesDataJson,
        completed: null,
        comment,
      })
    } catch (error) {
      console.error('⚠️ Не удалось создать запись отчёта перед анализом', error)
    }

    const transactionsWithIds = Array.isArray(extractedTransactions) ? extractedTransactions : []

    const { obviousRevenue, obviousNonRevenue, needsReview } = transactionProcessor.splitTransactionsByConfidence(transactionsWithIds)
    const classificationStats = {
      totalTransactions: transactionsWithIds.length,
      autoRevenue: obviousRevenue.length,
      autoNonRevenue: obviousNonRevenue.length,
      agentReviewed: needsReview.length,
    }

    console.log('🧮 Подготовка операций перед классификацией', {
      sessionId,
      ...classificationStats,
    })

    // Асинхронная обработка классификации
    ;(async () => {
      try {
        let runResult = null
        let rawNewItems = []
        let classificationEntries = []

        if (needsReview.length > 0) {
          if (!analysisRunner) {
            analysisRunner = new Runner({})
          }
          const classifierAgent = createTransactionClassifierAgent()
          const agentInput = [{
            role: 'user',
            content: [{
              type: 'input_text',
              text: transactionProcessor.buildClassifierPrompt(needsReview),
            }],
          }]

          console.log('🤖 Запускаем классификатор операций через Runner (async)', {
            sessionId,
            needsReview: needsReview.length,
          })

          runResult = await analysisRunner.run(classifierAgent, agentInput)

          rawNewItems = Array.isArray(runResult.newItems)
            ? runResult.newItems.map((item) => item?.rawItem || item)
            : []

          const historyLengthBefore = history.length
          if (rawNewItems.length > 0) {
            history.push(...rawNewItems)
          }

          for (let index = 0; index < rawNewItems.length; index += 1) {
            const item = rawNewItems[index]
            const role = item?.role
            if (role === 'assistant' || role === 'user') {
              try {
                await saveMessageToDB(sessionId, role, item.content, historyLengthBefore + index + 1)
              } catch (dbError) {
                if (dbError.code === 'XX000' || dbError.message?.includes('db_termination') || dbError.message?.includes('shutdown')) {
                  console.error('⚠️ БД соединение разорвано при сохранении сообщения агента. Продолжаем работу без сохранения в БД.')
                } else {
                  console.error('⚠️ Ошибка сохранения сообщения агента в БД (продолжаем работу):', dbError.message)
                }
              }
            }
          }

          let finalOutputText = ''
          if (typeof runResult.finalOutput === 'string') {
            finalOutputText = runResult.finalOutput.trim()
          } else if (runResult.finalOutput && typeof runResult.finalOutput === 'object' && typeof runResult.finalOutput.text === 'string') {
            finalOutputText = runResult.finalOutput.text.trim()
          }

          if (!finalOutputText) {
            finalOutputText =
              transactionProcessor.extractAssistantAnswer(rawNewItems) ||
              transactionProcessor.extractAssistantAnswer(Array.isArray(runResult.history) ? runResult.history : []) ||
              ''
          }

          classificationEntries = transactionProcessor.parseClassifierResponse(finalOutputText)

          console.log('🗂️ Результаты классификации от агента', {
            sessionId,
            parsedTransactions: classificationEntries.length,
            responseId: runResult.lastResponseId,
          })
        }

        const decisionsMap = new Map()
        for (const entry of classificationEntries) {
          if (!entry || !entry.id) continue
          const key = String(entry.id)
          const isRevenue =
            entry.is_revenue ??
            entry.isRevenue ??
            entry.revenue ??
            (entry.label === 'revenue')
          decisionsMap.set(key, {
            isRevenue: Boolean(isRevenue),
            reason: entry.reason || entry.explanation || '',
          })
        }

        const reviewedRevenue = []
        const reviewedNonRevenue = []

        for (const transaction of needsReview) {
          const decision =
            decisionsMap.get(String(transaction._ikap_tx_id)) ||
            decisionsMap.get(transaction._ikap_tx_id)
          const isRevenue = decision ? decision.isRevenue : false
          const reason =
            decision?.reason ||
            (decision ? '' : 'нет решения от агента, по умолчанию не выручка')

          const enriched = {
            ...transaction,
            _ikap_classification_source: decision ? 'agent' : 'agent_missing',
            _ikap_classification_reason: reason,
          }

          if (isRevenue) {
            reviewedRevenue.push(enriched)
          } else {
            reviewedNonRevenue.push(enriched)
          }
        }

        // Объединяем транзакции и сортируем по датам
        const finalNonRevenueTransactions = [...obviousNonRevenue, ...reviewedNonRevenue]
          .sort((a, b) => {
            const dateA = transactionProcessor.extractTransactionDate(a)
            const dateB = transactionProcessor.extractTransactionDate(b)
            if (!dateA && !dateB) return 0
            if (!dateA) return 1
            if (!dateB) return -1
            return dateA.getTime() - dateB.getTime()
          })
        const finalRevenueTransactions = [...obviousRevenue, ...reviewedRevenue]
          .sort((a, b) => {
            const dateA = transactionProcessor.extractTransactionDate(a)
            const dateB = transactionProcessor.extractTransactionDate(b)
            if (!dateA && !dateB) return 0
            if (!dateA) return 1
            if (!dateB) return -1
            return dateA.getTime() - dateB.getTime()
          })

        const sortedObviousRevenue = [...obviousRevenue].sort((a, b) => {
          const dateA = transactionProcessor.extractTransactionDate(a)
          const dateB = transactionProcessor.extractTransactionDate(b)
          if (!dateA && !dateB) return 0
          if (!dateA) return 1
          if (!dateB) return -1
          return dateA.getTime() - dateB.getTime()
        })

        const structuredSummary = transactionProcessor.buildStructuredSummary({
          revenueTransactions: finalRevenueTransactions,
          nonRevenueTransactions: finalNonRevenueTransactions,
          stats: {
            ...classificationStats,
            agentDecisions: decisionsMap.size,
            unresolved: Math.max(0, needsReview.length - decisionsMap.size),
          },
          autoRevenuePreview: transactionProcessor.buildTransactionsPreview(sortedObviousRevenue, { limit: 10000 }),
          convertedExcels,
        })

        const completedAt = new Date().toISOString()
        const finalReportPayload = JSON.stringify(structuredSummary, null, 2)
        const formattedReportText = transactionProcessor.formatReportAsText(structuredSummary)
        const openaiStatus =
          needsReview.length === 0 ? 'skipped' : decisionsMap.size > 0 ? 'completed' : 'partial'

        await upsertReport(sessionId, {
          status: 'completed',
          reportText: formattedReportText,
          reportStructured: finalReportPayload,
          filesCount: files.length,
          filesData: filesDataJson,
          completed: completedAt,
          comment,
          openaiResponseId: runResult?.lastResponseId || null,
          openaiStatus,
        })

        console.log('📦 Классификация операций завершена (async)', {
          sessionId,
          durationMs: Date.now() - startedAt.getTime(),
          totalTransactions: transactionsWithIds.length,
          autoRevenue: obviousRevenue.length,
          autoNonRevenue: obviousNonRevenue.length,
          reviewedByAgent: needsReview.length,
          agentDecisions: decisionsMap.size,
        })
      } catch (streamError) {
        console.error('❌ Ошибка в фоне при обработке классификации', {
          sessionId,
          error: streamError.message,
        })
        try {
          await upsertReport(sessionId, {
            status: 'failed',
            reportText: streamError.message,
            reportStructured: null,
            filesCount: files.length,
            filesData: filesDataJson,
            completed: new Date().toISOString(),
            comment,
            openaiResponseId: null,
            openaiStatus: 'failed',
          })
        } catch (dbError) {
          console.error('⚠️ Не удалось зафиксировать ошибку в БД (async)', dbError)
        }
      } finally {
        activeAnalysisSessions.delete(sessionId)
      }
    })().catch((unhandled) => {
      console.error('❌ Необработанная ошибка фоновой классификации', {
        sessionId,
        error: unhandled?.message || unhandled,
      })
      activeAnalysisSessions.delete(sessionId)
    })

    const progress = await getSessionProgress(sessionId)

    return res.status(202).json({
      ok: true,
      sessionId,
      status: 'generating',
      openaiStatus: 'generating',
      message: 'Анализ запущен. Обновите историю позже, чтобы увидеть результат.',
      data: {
        progress,
      },
      completed: false,
    })
  } catch (error) {
    console.error('❌ Ошибка анализа выписок', {
      sessionId,
      error: error.message,
      stack: error.stack,
    })

    activeAnalysisSessions.delete(sessionId)

    try {
      await upsertReport(sessionId, {
        status: 'failed',
        reportText: error.message,
        reportStructured: null,
        filesCount: files.length,
        filesData: JSON.stringify(summariseFilesForLog(files)),
        completed: new Date().toISOString(),
        comment,
        openaiStatus: 'failed',
      })
    } catch (dbError) {
      console.error('⚠️ Не удалось зафиксировать ошибку в БД', dbError)
    }

    return res.status(500).json({
      ok: false,
      code: 'ANALYSIS_FAILED',
      message: 'Не удалось завершить анализ выписок. Проверьте логи на сервере.',
      error: error.message,
    })
  }
})

// Эндпоинт для получения финансового отчета
// Эндпоинт для получения отчета по session_id
app.get('/api/reports/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  
  console.log(`📊 Запрос отчета для сессии: ${sessionId}`)
  
  try {
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
      SELECT file_id, original_name, mime_type, file_data, file_path
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
    
    // Fallback: пытаемся прочитать из файловой системы (для старых файлов)
    if (!buffer && file.file_path) {
      const filePath = path.join(__dirname, file.file_path)
      if (fs.existsSync(filePath)) {
        try {
          buffer = fs.readFileSync(filePath)
          console.log(`✅ Файл прочитан из файловой системы (fallback): ${filePath}`)
        } catch (readError) {
          console.error(`⚠️ Ошибка чтения файла из файловой системы:`, readError.message)
        }
      }
    }
    
    // Fallback: пытаемся загрузить из OpenAI (только для старых файлов с OpenAI fileId)
    // Локальные файлы (fileId начинается с "local-") не загружаются в OpenAI
    if (!buffer && !fileId.startsWith('local-')) {
      try {
        console.log(`⚠️ Пытаемся загрузить файл из OpenAI как fallback...`)
        const fileContent = await openaiClient.files.content(fileId)
        buffer = Buffer.from(await fileContent.arrayBuffer())
        console.log(`✅ Файл загружен из OpenAI (fallback)`)
      } catch (openaiError) {
        console.error(`❌ Ошибка загрузки файла из OpenAI:`, openaiError.message)
        // Если это ошибка о purpose 'assistants', сообщаем об этом
        if (openaiError.message?.includes('Not allowed to download files of purpose: assistants')) {
          return res.status(500).json({
            ok: false,
            message: 'Файл недоступен для скачивания. Файл не найден в БД.'
          })
        }
        throw openaiError
      }
    }
    
    if (!buffer) {
      return res.status(404).json({
        ok: false,
        message: 'Файл не найден в БД, файловой системе или OpenAI'
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
             openai_response_id, openai_status, tax_report_text, fs_report_text,
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
        modelSettings
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
  const { instructions, role, functionality, mcpConfig, model, modelSettings } = req.body
  console.log(`💾 Обновление настроек агента: ${agentName}`)
  
  try {
    // Валидация
    if (!instructions || typeof instructions !== 'string') {
      return res.status(400).json({
        ok: false,
        message: 'Поле instructions обязательно и должно быть строкой'
      })
    }
    
    const updateSettings = db.prepare(`
      INSERT INTO agent_settings (agent_name, instructions, role, functionality, mcp_config, model, model_settings, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (agent_name) DO UPDATE SET
        instructions = EXCLUDED.instructions,
        role = EXCLUDED.role,
        functionality = EXCLUDED.functionality,
        mcp_config = EXCLUDED.mcp_config,
        model = EXCLUDED.model,
        model_settings = EXCLUDED.model_settings,
        updated_at = CURRENT_TIMESTAMP
    `)
    
    await updateSettings.run(
      agentName,
      instructions,
      role || null,
      functionality || null,
      mcpConfig ? JSON.stringify(mcpConfig) : null,
      model || 'gpt-5-mini',
      modelSettings ? JSON.stringify(modelSettings) : JSON.stringify({ store: true })
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
  console.log(`[server] PDF_SERVICE_URL: ${process.env.PDF_SERVICE_URL ? 'configured' : 'missing'}`)
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

