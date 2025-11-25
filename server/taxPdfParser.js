/**
 * Модуль для парсинга PDF налоговых деклараций в текстовый формат
 * Использует Python скрипт из папки taxpdfto
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { promisify } = require('util')
const { randomUUID } = require('crypto')

const writeFile = promisify(fs.writeFile)
const unlink = promisify(fs.unlink)
const mkdir = promisify(fs.mkdir)
const readFile = promisify(fs.readFile)

// Путь к папке taxpdfto
const TAX_PDF_TO_PATH = process.env.TAX_PDF_TO_PATH || 
  path.join(__dirname, '..', 'taxpdfto')

// Путь к app.py
const APP_PY_PATH = path.join(TAX_PDF_TO_PATH, 'app.py')

/**
 * Парсит PDF файл в текстовый формат используя Python скрипт
 * @param {Buffer} pdfBuffer - Байты PDF файла
 * @param {string} filename - Имя файла
 * @returns {Promise<string>} Распарсенный текст
 */
async function parseTaxPdfToText(pdfBuffer, filename) {
  const tempDir = path.join(__dirname, '..', 'temp_parsing')
  const tempPdfPath = path.join(tempDir, `${randomUUID()}_${filename}`)
  const tempOutputPath = path.join(tempDir, `${randomUUID()}_output.txt`)

  try {
    // Создаем временную директорию если её нет
    await mkdir(tempDir, { recursive: true })

    // Сохраняем PDF во временный файл
    await writeFile(tempPdfPath, pdfBuffer)
    console.log(`📝 Временный PDF файл создан: ${tempPdfPath}`)

    // Вызываем Python скрипт для парсинга
    const parsedText = await parsePdfWithPython(tempPdfPath, tempOutputPath)

    return parsedText
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
  parseTaxPdfToText
}

