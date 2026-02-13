const axios = require('axios')
const FormData = require('form-data')

/**
 * Отправляет все документы сессии в сервис onepage для проверки комплектности.
 * Ожидает:
 * - db: экземпляр БД
 * - normalizeFileName: функция нормализации имени файла
 * - baseUrl: базовый URL сервиса onepage
 */
async function runDocumentsOverviewAnalysis(db, normalizeFileName, baseUrl, sessionId) {
  if (!baseUrl) return

  try {
    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, '')

    // Получаем байты файлов из БД
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

    const formData = new FormData()
    let hasBankTax = false
    let hasFinancial = false

    for (const f of dbFiles) {
      if (!f.file_data) continue
      const buffer = Buffer.isBuffer(f.file_data) ? f.file_data : Buffer.from(f.file_data)
      const filename = normalizeFileName(f.original_name || 'document.pdf')
      const mime = f.mime_type || 'application/pdf'

      if (f.category === 'financial') {
        formData.append('financial', buffer, { filename, contentType: mime })
        hasFinancial = true
      } else if (f.category === 'statements' || f.category === 'taxes') {
        formData.append('bankTax', buffer, { filename, contentType: mime })
        hasBankTax = true
      }
    }

    if (!hasBankTax && !hasFinancial) {
      console.log(`⚠️ [onepage] Нет подходящих файлов (statements/taxes/financial) для сессии ${sessionId}`)
      return
    }

    console.log(`📤 [onepage] Отправляем документы сессии ${sessionId} на превью...`)
    const previewRes = await axios.post(`${cleanBaseUrl}/api/preview`, formData, {
      headers: formData.getHeaders(),
      timeout: 180000, // до 3 минут на конвертацию
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    })

    const previewIds = (previewRes.data?.previews || []).map(p => p.id).filter(Boolean)
    if (!previewIds.length) {
      console.warn(`⚠️ [onepage] Сервис вернул пустой список превью для сессии ${sessionId}`)
      return
    }

    console.log(`📊 [onepage] Превью создано, id: ${previewIds.join(', ')}. Запрашиваем анализ...`)
    const analyzeRes = await axios.post(`${cleanBaseUrl}/api/analyze`, {
      ids: previewIds,
      note: `ikap session ${sessionId}`,
    }, {
      timeout: 600000, // до 10 минут на анализ (изображения + GPT)
    })

    const result = analyzeRes.data?.result || analyzeRes.data
    const jsonValue = result ? JSON.stringify(result) : null
    const textSummary = result?.overallConclusion?.missingSummary || null

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

