/**
 * Сервис для анализа финансовой отчётности через pdftopng (Render.com).
 * Отправляет PDF на внешний сервис, получает таблицу и краткий анализ.
 */

const axios = require('axios')
const FormData = require('form-data')

const FINANCIAL_PDF_SERVICE_URL = process.env.FINANCIAL_PDF_SERVICE_URL || ''
const USE_FINANCIAL_PDF_SERVICE = !!FINANCIAL_PDF_SERVICE_URL

const POLL_INTERVAL_MS = 3000
const MAX_POLL_ATTEMPTS = 120 // 6 минут при интервале 3 сек
const UPLOAD_TIMEOUT_MS = 120000 // 2 мин на загрузку
const REQUEST_TIMEOUT_MS = 10000 // 10 сек на каждый poll

if (USE_FINANCIAL_PDF_SERVICE) {
  console.log(`📡 Financial PDF (pdftopng) включен: ${FINANCIAL_PDF_SERVICE_URL}`)
} else {
  console.log('📄 Financial PDF: используется Cloud Run OCR + агент (FINANCIAL_PDF_SERVICE_URL не задан)')
}

/**
 * Форматирует число для отображения
 */
function formatNum(n) {
  if (n == null) return '—'
  if (typeof n !== 'number') return String(n)
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })
}

/**
 * Преобразует результат pdftopng в текст отчёта (Markdown)
 */
function formatAnalysisAsReport(data) {
  const { summary = '', table = [], years = [] } = data
  const parts = []

  if (summary) {
    parts.push('## Краткий анализ\n\n' + summary)
  }

  if (table.length > 0 && years.length > 0) {
    parts.push('\n## Финансовые показатели\n')
    const headerRow = ['Показатель', ...years].join(' | ')
    const separator = ['---', ...years.map(() => '---')].join(' | ')
    const rows = table.map(row => {
      const indicator = row.indicator || ''
      const values = years.map(y => formatNum(row.values?.[y]))
      return [indicator, ...values].join(' | ')
    })
    parts.push(`| ${headerRow} |`)
    parts.push(`| ${separator} |`)
    rows.forEach(r => parts.push(`| ${r} |`))
  }

  return parts.join('\n\n').trim()
}

/**
 * Отправляет PDF файлы на pdftopng и ждёт результат анализа.
 * @param {Array<{buffer: Buffer, originalName: string}>} pdfFiles - массив PDF с buffer
 * @returns {Promise<{report: string, table: Array, years: Array, summary: string}>}
 */
async function analyzeFinancialPdfsViaPdftopng(pdfFiles) {
  if (!USE_FINANCIAL_PDF_SERVICE) {
    throw new Error('FINANCIAL_PDF_SERVICE_URL не задан')
  }

  const baseUrl = FINANCIAL_PDF_SERVICE_URL.trim().replace(/\/+$/, '')

  const formData = new FormData()
  pdfFiles.forEach(f => {
    formData.append('files', f.buffer, {
      filename: f.originalName,
      contentType: 'application/pdf'
    })
  })

  const uploadUrl = `${baseUrl}/upload?dpi=150`
  console.log(`📤 Отправляем ${pdfFiles.length} PDF на pdftopng...`)

  const uploadRes = await axios.post(uploadUrl, formData, {
    headers: formData.getHeaders(),
    timeout: UPLOAD_TIMEOUT_MS,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  })

  const { id } = uploadRes.data || {}
  if (!id) {
    throw new Error('pdftopng не вернул id конвертации')
  }

  console.log(`⏳ Ожидаем результат анализа (id=${id}), опрос каждые ${POLL_INTERVAL_MS / 1000} сек...`)

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

    const analysisRes = await axios.get(`${baseUrl}/api/analysis/${id}`, {
      timeout: REQUEST_TIMEOUT_MS
    })

    const data = analysisRes.data || {}
    const status = data.status

    if (status === 'completed') {
      console.log(`✅ Анализ от pdftopng получен`)
      const report = formatAnalysisAsReport(data)
      return {
        report,
        table: data.table || [],
        years: data.years || [],
        summary: data.summary || ''
      }
    }

    if (status === 'error') {
      throw new Error(data.error || 'Ошибка анализа на pdftopng')
    }
  }

  throw new Error(`Таймаут ожидания анализа от pdftopng (${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60000} мин)`)
}

module.exports = {
  USE_FINANCIAL_PDF_SERVICE,
  analyzeFinancialPdfsViaPdftopng
}
