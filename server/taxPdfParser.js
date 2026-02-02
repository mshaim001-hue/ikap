/**
 * Модуль для парсинга PDF налоговых деклараций в текстовый формат
 *
 * Режимы работы:
 * 1) HTTP (Render.com): если задан TAX_PDF_SERVICE_URL – отправляем PDF на внешний сервис и получаем текст
 * 2) Локальный Python: по умолчанию используем taxpdfto/app.py через subprocess
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { promisify } = require('util')
const { randomUUID } = require('crypto')
const axios = require('axios')
const FormData = require('form-data')

const writeFile = promisify(fs.writeFile)
const unlink = promisify(fs.unlink)
const mkdir = promisify(fs.mkdir)
const readFile = promisify(fs.readFile)

// Путь к папке taxpdfto (для локального Python режима)
const TAX_PDF_TO_PATH = process.env.TAX_PDF_TO_PATH || 
  path.join(__dirname, '..', 'taxpdfto')

// ikap3 (taxpdfto): по умолчанию https://ikap3-backend-latest.onrender.com
const TAX_PDF_SERVICE_URL = process.env.TAX_PDF_SERVICE_URL || 'https://ikap3-backend-latest.onrender.com'
const USE_TAX_PDF_SERVICE_HTTP = !!TAX_PDF_SERVICE_URL

// Логируем режим работы сразу при загрузке модуля
if (USE_TAX_PDF_SERVICE_HTTP) {
  console.log(`📡 Tax OCR (ikap3/taxpdfto): ${TAX_PDF_SERVICE_URL}`)
} else {
  console.log('🐍 Tax OCR: используется локальный Python (TAX_PDF_SERVICE_URL не задан)')
}

/**
 * Парсит PDF файл в текстовый формат используя Python скрипт
 * @param {Buffer} pdfBuffer - Байты PDF файла
 * @param {string} filename - Имя файла
 * @param {boolean} withAnalysis - Если true, также получает анализ от агента
 * @returns {Promise<{text: string, analysis?: string}>} Распарсенный текст и опционально анализ
 */
async function parseTaxPdfToText(pdfBuffer, filename, withAnalysis = false) {
  // Если настроен внешний HTTP сервис (Render.com) – используем его
  if (USE_TAX_PDF_SERVICE_HTTP) {
    return parseTaxPdfToTextViaHttp(pdfBuffer, filename, withAnalysis)
  }

  // Иначе используем локальный Python скрипт (анализ не поддерживается локально)
  const tempDir = path.join(__dirname, '..', 'temp_parsing')
  const tempPdfPath = path.join(tempDir, `${randomUUID()}_${filename}`)
  const tempOutputPath = path.join(tempDir, `${randomUUID()}_output.txt`)

  try {
    // Создаем временную директорию если её нет
    await mkdir(tempDir, { recursive: true })

    // Сохраняем PDF во временный файл
    await writeFile(tempPdfPath, pdfBuffer)

    // Вызываем Python скрипт для парсинга
    const parsedText = await parsePdfWithPython(tempPdfPath, tempOutputPath)

    return { text: parsedText }
  } catch (error) {
    console.error(`❌ Ошибка парсинга PDF ${filename}:`, error)
    throw error
  } finally {
    // Удаляем временные файлы
    try {
      if (fs.existsSync(tempPdfPath)) {
        await unlink(tempPdfPath)
      }
      if (fs.existsSync(tempOutputPath)) {
        await unlink(tempOutputPath)
      }
    } catch (cleanupError) {
      console.warn(`⚠️ Не удалось удалить временные файлы:`, cleanupError)
    }
  }
}

/**
 * Парсит PDF через HTTP сервис (Render.com tax-ocr-service)
 * Ожидаемый формат ответа:
 * {
 *   "files": [
 *     {"filename": "...", "text": "...", "analysis": "..."},
 *     ...
 *   ]
 * }
 */
async function parseTaxPdfToTextViaHttp(pdfBuffer, filename, withAnalysis = false) {
  if (!TAX_PDF_SERVICE_URL) {
    throw new Error('TAX_PDF_SERVICE_URL не задан, не могу использовать HTTP режим для налогового парсера')
  }

  const formData = new FormData()
  formData.append('files', pdfBuffer, {
    filename,
    contentType: 'application/pdf'
  })

  // Нормализуем URL (убираем трейлинг слэши)
  const baseUrl = TAX_PDF_SERVICE_URL.trim().replace(/\/+$/, '')
  // Добавляем параметр analyze=true если требуется анализ
  const serviceUrl = `${baseUrl}/process${withAnalysis ? '?analyze=true' : ''}`

  // Даем достаточно времени, так как PDF могут быть большими, а анализ может занять время
  const TIMEOUT_MS = withAnalysis ? 1200000 : 600000
  const MAX_RETRIES = 2
  const RETRY_DELAY_MS = 3000

  function parseResponseData(data) {
    const files = Array.isArray(data.files) ? data.files : []
    if (!files.length) throw new Error('tax-ocr-service вернул пустой результат (нет файлов)')
    const normalizedName = filename.toLowerCase()
    let fileEntry = files.find(f => (f.filename || '').toLowerCase() === normalizedName)
    if (!fileEntry) fileEntry = files[0]
    if (!fileEntry || !fileEntry.text) throw new Error('tax-ocr-service вернул результат без текста')
    const text = String(fileEntry.text || '').trim()
    if (!text) throw new Error('tax-ocr-service вернул пустой текст')
    const result = { text }
    if (withAnalysis && fileEntry.analysis) result.analysis = String(fileEntry.analysis || '').trim()
    return result
  }

  function throwWithLog(error) {
    if (error.response) {
      if (error.response.status === 404) {
        console.error(`❌ tax-ocr-service (ikap3) вернул 404. URL: ${serviceUrl}`)
        console.error(`   Проверьте: 1) сервис ikap3 запущен на Render; 2) маршрут POST /process существует (taxpdfto app.py).`)
      }
      const errMsg = error.response.data?.error || error.response.statusText || error.message
      console.error('❌ Ошибка tax-ocr-service (HTTP):', error.response.status, errMsg)
      throw new Error(`Ошибка tax-ocr-service (${error.response.status}): ${errMsg}`)
    }
    if (error.code === 'ECONNABORTED' || `${error.message}`.includes('timeout')) {
      console.error(`⏱️ Таймаут запроса к tax-ocr-service после ${TIMEOUT_MS / 1000} секунд`)
      throw new Error(`tax-ocr-service не ответил в течение ${TIMEOUT_MS / 1000} секунд`)
    }
    if (error.request) {
      console.error('❌ tax-ocr-service не ответил:', error.message)
      throw new Error(`tax-ocr-service не ответил: ${error.message}`)
    }
    console.error('❌ Ошибка при вызове tax-ocr-service:', error.message)
    throw new Error(`Ошибка при вызове tax-ocr-service: ${error.message}`)
  }

  const opts = { timeout: TIMEOUT_MS, maxContentLength: Infinity, maxBodyLength: Infinity }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`🔄 Повтор запроса к tax-ocr-service (${attempt}/${MAX_RETRIES}) через ${RETRY_DELAY_MS / 1000} сек: ${filename}`)
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        const retryForm = new FormData()
        retryForm.append('files', pdfBuffer, { filename, contentType: 'application/pdf' })
        const res = await axios.post(serviceUrl, retryForm, { ...opts, headers: retryForm.getHeaders() })
        if (res.status !== 200) throw new Error(`Неожиданный статус: ${res.status}`)
        return parseResponseData(res.data || {})
      }
      const response = await axios.post(serviceUrl, formData, { ...opts, headers: formData.getHeaders() })
      if (response.status !== 200) throw new Error(`Неожиданный статус ответа от tax-ocr-service: ${response.status}`)
      return parseResponseData(response.data || {})
    } catch (error) {
      const is404 = error.response && error.response.status === 404
      if (is404 && attempt < MAX_RETRIES) continue
      throwWithLog(error)
    }
  }
  throwWithLog(new Error('Превышено число повторов'))
}

/**
 * Отправляет один запрос в ikap3 (taxpdfto) с несколькими PDF — один анализ в списке сервиса.
 * @param {Array<{buffer: Buffer, filename: string}>} files - массив { buffer, filename }
 * @param {boolean} withAnalysis - запрашивать анализ от агента
 * @returns {Promise<{files: Array<{filename: string, text: string, analysis?: string}>}>}
 */
async function parseTaxPdfsBatchViaHttp(files, withAnalysis = false) {
  if (!TAX_PDF_SERVICE_URL || !Array.isArray(files) || files.length === 0) {
    throw new Error('TAX_PDF_SERVICE_URL не задан или нет файлов для батч-запроса')
  }

  const formData = new FormData()
  for (const { buffer, filename } of files) {
    formData.append('files', buffer, {
      filename: filename || 'document.pdf',
      contentType: 'application/pdf'
    })
  }

  const baseUrl = TAX_PDF_SERVICE_URL.trim().replace(/\/+$/, '')
  const serviceUrl = `${baseUrl}/process${withAnalysis ? '?analyze=true' : ''}`

  const TIMEOUT_MS = withAnalysis ? 1200000 : 600000
  const MAX_RETRIES = 2
  const RETRY_DELAY_MS = 3000

  const opts = { timeout: TIMEOUT_MS, maxContentLength: Infinity, maxBodyLength: Infinity }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`🔄 Повтор батч-запроса к taxpdfto (${attempt}/${MAX_RETRIES}) через ${RETRY_DELAY_MS / 1000} сек, файлов: ${files.length}`)
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        const retryForm = new FormData()
        for (const { buffer, filename } of files) {
          retryForm.append('files', buffer, { filename: filename || 'document.pdf', contentType: 'application/pdf' })
        }
        const res = await axios.post(serviceUrl, retryForm, { ...opts, headers: retryForm.getHeaders() })
        if (res.status !== 200) throw new Error(`Неожиданный статус: ${res.status}`)
        return res.data || { files: [] }
      }
      const response = await axios.post(serviceUrl, formData, { ...opts, headers: formData.getHeaders() })
      if (response.status !== 200) throw new Error(`Неожиданный статус ответа: ${response.status}`)
      return response.data || { files: [] }
    } catch (error) {
      const is404 = error.response && error.response.status === 404
      if (is404 && attempt < MAX_RETRIES) continue
      if (error.response) {
        console.error(`❌ taxpdfto батч: ${error.response.status}`, error.response.data?.error || error.message)
      } else {
        console.error('❌ taxpdfto батч:', error.message)
      }
      throw error
    }
  }
  throw new Error('Превышено число повторов батч-запроса к taxpdfto')
}

/**
 * Вызывает Python скрипт для парсинга PDF
 * @param {string} pdfPath - Путь к PDF файлу
 * @param {string} outputPath - Путь для сохранения результата
 * @returns {Promise<string>} Распарсенный текст
 */
function parsePdfWithPython(pdfPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Экранируем пути для использования в Python строке
    const escapedPdfPath = pdfPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedOutputPath = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedTaxPath = TAX_PDF_TO_PATH.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    
    // Импортируем функции из app.py напрямую через Python
    const pythonScript = `
import sys
import os
sys.path.insert(0, r'${escapedTaxPath}')

try:
    from app import parse_pdf
except ImportError as e:
    print(f"ERROR: Не удалось импортировать parse_pdf: {e}", file=sys.stderr)
    sys.exit(1)

pdf_path = r'${escapedPdfPath}'
if not os.path.exists(pdf_path):
    print(f"ERROR: Файл не найден: {pdf_path}", file=sys.stderr)
    sys.exit(1)

text, error = parse_pdf(pdf_path)

if error:
    print(f"ERROR: {error}", file=sys.stderr)
    sys.exit(1)

# Сохраняем результат в файл
try:
    with open(r'${escapedOutputPath}', 'w', encoding='utf-8') as f:
        f.write(text)
except Exception as e:
    print(f"ERROR: Не удалось сохранить результат: {e}", file=sys.stderr)
    sys.exit(1)

print(text)
`

    // Определяем Python executable
    const pythonExecutable = process.env.PYTHON_PATH || 'python3'
    
    const pythonProcess = spawn(pythonExecutable, ['-c', pythonScript], {
      cwd: TAX_PDF_TO_PATH,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { 
        ...process.env, 
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: `${TAX_PDF_TO_PATH}:${process.env.PYTHONPATH || ''}`
      }
    })

    let stdout = ''
    let stderr = ''

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python скрипт завершился с ошибкой (код ${code}): ${stderr}`))
        return
      }

      // Пытаемся прочитать из файла, если stdout пустой
      if (!stdout.trim() && fs.existsSync(outputPath)) {
        readFile(outputPath, 'utf-8')
          .then(resolve)
          .catch(() => resolve(stdout.trim() || ''))
      } else {
        resolve(stdout.trim() || '')
      }
    })

    pythonProcess.on('error', (error) => {
      reject(new Error(`Не удалось запустить Python процесс: ${error.message}`))
    })
  })
}

module.exports = {
  parseTaxPdfToText,
  parseTaxPdfsBatchViaHttp
}

