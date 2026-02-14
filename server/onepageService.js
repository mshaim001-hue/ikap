const axios = require('axios')
const FormData = require('form-data')

/**
 * Отправляет все документы сессии в сервис onepage для проверки комплектности.
 * Ожидает:
 * - db: экземпляр БД
 * - normalizeFileName: функция нормализации имени файла
 * - baseUrl: базовый URL сервиса onepage
 */
const AXIOS_PREVIEW_OPTS = {
  timeout: 180000, // до 3 минут на конвертацию
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
}

const AXIOS_ANALYZE_OPTS = {
  timeout: 600000, // до 10 минут на анализ
}

/** Вызывает /api/preview + /api/analyze для набора файлов. Возвращает result или null. */
async function runOneBatch(cleanBaseUrl, formData, sessionId, label) {
  const previewRes = await axios.post(`${cleanBaseUrl}/api/preview`, formData, {
    headers: formData.getHeaders(),
    ...AXIOS_PREVIEW_OPTS,
  })

  const previewIds = (previewRes.data?.previews || []).map(p => p.id).filter(Boolean)
  if (!previewIds.length) {
    console.warn(`⚠️ [onepage] ${label}: пустой список превью для сессии ${sessionId}`)
    return null
  }

  console.log(`📊 [onepage] ${label}: превью создано, id: ${previewIds.join(', ')}. Запрашиваем анализ...`)
  const analyzeRes = await axios.post(`${cleanBaseUrl}/api/analyze`, {
    ids: previewIds,
    note: `ikap session ${sessionId} ${label}`,
  }, AXIOS_ANALYZE_OPTS)

  return analyzeRes.data?.result || analyzeRes.data
}

/** Мержит результаты bankTax и financial в один объект. */
function mergeResults(resultBankTax, resultFinancial) {
  const documents = [
    ...(resultBankTax?.documents || []),
    ...(resultFinancial?.documents || []),
  ]

  const c1 = resultBankTax?.completeness || {}
  const c2 = resultFinancial?.completeness || {}
  const hasBoth = resultBankTax && resultFinancial
  const completeness = {
    ...c1,
    ...c2,
    bankStatements: c1.bankStatements || c2.bankStatements || { present: [], missing: [] },
    taxReports: c1.taxReports || c2.taxReports || { present: [], missing: [] },
    financialReports: c2.financialReports || c1.financialReports || { present: [], missing: [] },
    overallComplete: hasBoth
      ? (!!c1.overallComplete && !!c2.overallComplete)
      : (c1.overallComplete ?? c2.overallComplete ?? null),
  }

  return { documents, completeness, summaryText: completeness.summaryText || null }
}

async function runDocumentsOverviewAnalysis(db, normalizeFileName, baseUrl, sessionId) {
  if (!baseUrl) return

  try {
    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, '')

    const dbFiles = await db.prepare(`
      SELECT file_id, original_name, file_size, mime_type, category, file_data
      FROM files
      WHERE session_id = ?
      ORDER BY uploaded_at ASC
    `).all(sessionId)

    if (!dbFiles || dbFiles.length === 0) {
      console.log(`⚠️ [onepage] Нет файлов в БД для сессии ${sessionId}`)
      return
    }

    const bankTaxFiles = []
    const financialFiles = []

    for (const f of dbFiles) {
      if (!f.file_data) continue
      const buffer = Buffer.isBuffer(f.file_data) ? f.file_data : Buffer.from(f.file_data)
      const filename = normalizeFileName(f.original_name || 'document.pdf')
      const mime = f.mime_type || 'application/pdf'
      const entry = { buffer, filename, mime }

      if (f.category === 'financial') {
        financialFiles.push(entry)
      } else if (f.category === 'statements' || f.category === 'taxes') {
        bankTaxFiles.push(entry)
      }
    }

    if (bankTaxFiles.length === 0 && financialFiles.length === 0) {
      console.log(`⚠️ [onepage] Нет подходящих файлов (statements/taxes/financial) для сессии ${sessionId}`)
      return
    }

    let resultBankTax = null
    let resultFinancial = null

    if (bankTaxFiles.length > 0) {
      const formDataBankTax = new FormData()
      for (const { buffer, filename, mime } of bankTaxFiles) {
        formDataBankTax.append('bankTax', buffer, { filename, contentType: mime })
      }
      console.log(`📤 [onepage] Отправляем банковские выписки и налоговые формы (${bankTaxFiles.length} файлов)...`)
      resultBankTax = await runOneBatch(cleanBaseUrl, formDataBankTax, sessionId, 'bankTax')
    }

    if (financialFiles.length > 0) {
      const formDataFinancial = new FormData()
      for (const { buffer, filename, mime } of financialFiles) {
        formDataFinancial.append('financial', buffer, { filename, contentType: mime })
      }
      console.log(`📤 [onepage] Отправляем финансовую отчётность (${financialFiles.length} файлов)...`)
      resultFinancial = await runOneBatch(cleanBaseUrl, formDataFinancial, sessionId, 'financial')
    }

    const result = mergeResults(resultBankTax, resultFinancial)
    const jsonValue = JSON.stringify(result)
    const textSummary = result.summaryText || null

    await db.prepare(`
      UPDATE reports
      SET docs_overview_json = ?, docs_overview_text = ?
      WHERE session_id = ?
    `).run(jsonValue, textSummary, sessionId)

    console.log(`✅ [onepage] Анализ комплектности документов сохранён для сессии ${sessionId}`)
  } catch (error) {
    console.error(`❌ [onepage] Ошибка анализа документов для сессии ${sessionId}:`, error.message)
    try {
      await db.prepare(`
        UPDATE reports
        SET docs_overview_text = ?
        WHERE session_id = ?
      `).run(`Ошибка сервиса проверки документов (onepage): ${error.message}`, sessionId)
    } catch (dbError) {
      console.error('❌ [onepage] Не удалось сохранить текст ошибки в БД:', dbError.message)
    }
  }
}

module.exports = {
  runDocumentsOverviewAnalysis,
}

