/**
 * Модуль для конвертации PDF выписок в JSON через внешний HTTP‑сервис (Cloud Run).
 * Локальный Python больше не используется – только STATEMENT_PDF_SERVICE_URL.
 */
const PDF_SERVICE_PORT = process.env.PDF_SERVICE_PORT || 8000
// Отдельный HTTP-сервис для конвертации выписок (Cloud Run)
const STATEMENT_PDF_SERVICE_URL = process.env.STATEMENT_PDF_SERVICE_URL || `http://localhost:${PDF_SERVICE_PORT}`

/**
 * Конвертирует PDF файл в JSON через внешний HTTP‑сервис
 * @param {Buffer} pdfBuffer - Байты PDF файла
 * @param {string} filename - Имя файла
 * @returns {Promise<Array>} Массив с результатами конвертации
 */
async function convertPdfToJson(pdfBuffer, filename) {
  return convertPdfToJsonViaHttp(pdfBuffer, filename)
}

/**
 * Конвертация через HTTP запрос к сервису выписок (Cloud Run)
 */
async function convertPdfToJsonViaHttp(pdfBuffer, filename) {
  const FormData = require('form-data')
  const axios = require('axios')
  
  const formData = new FormData()
  formData.append('files', pdfBuffer, {
    filename: filename,
    contentType: 'application/pdf'
  })

  try {
    const response = await axios.post(`${STATEMENT_PDF_SERVICE_URL}/process`, formData, {
      headers: formData.getHeaders(),
      timeout: 300000, // 5 минут таймаут для больших файлов
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    })

    if (response.status === 204) {
      // Нет строк с кредитом
      return []
    }

    return Array.isArray(response.data) ? response.data : [response.data]
  } catch (error) {
    console.error('❌ Ошибка HTTP запроса к PDF-сервису:', error.message)
    if (error.response) {
      console.error('Response status:', error.response.status)
      console.error('Response data:', error.response.data)
    }
    throw new Error(`Не удалось конвертировать PDF через HTTP: ${error.message}`)
  }
}

/**
 * Конвертирует массив PDF файлов в JSON
 * @param {Array<{buffer: Buffer, filename: string}>} files - Массив файлов
 * @returns {Promise<Array>} Массив результатов конвертации
 */
async function convertPdfsToJson(files) {
  const results = []
  
  for (const file of files) {
    try {
      const result = await convertPdfToJson(file.buffer, file.filename)
      
      // Python скрипт возвращает массив документов, каждый документ имеет структуру:
      // {source_file: string, metadata: object, transactions: array}
      // Мы просто добавляем все документы в results
      if (Array.isArray(result)) {
        // Если это массив документов, добавляем каждый документ
        for (const doc of result) {
          if (doc && typeof doc === 'object') {
            results.push(doc)
          }
        }
      } else if (result && typeof result === 'object') {
        // Если это один документ, добавляем его
        results.push(result)
      } else {
        console.warn(`⚠️ Неожиданный тип результата: ${typeof result}`, result)
      }
    } catch (error) {
      console.error(`❌ Ошибка конвертации файла ${file.filename}:`, error.message)
      // Добавляем ошибку в результат, чтобы пользователь видел, что произошло
      results.push({
        source_file: file.filename,
        metadata: {},
        transactions: [],
        error: error.message
      })
    }
  }
  
  return results
}

module.exports = {
  convertPdfToJson,
  convertPdfsToJson
}

