const axios = require('axios')
const transactionProcessor = require('../transactionProcessor')

function createReportsRouter({ db, USE_IKAP2_FOR_STATEMENTS, IKAP2_BACKEND_URL, upsertReport }) {
  const express = require('express')
  const router = express.Router()

  // Эндпоинт для получения отчета по session_id
  router.get('/:sessionId', async (req, res) => {
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

            // Локальные поля (налог, фин. отчётность, onepage) — не перезатирать данными от ikap2
            const localReport = await db.prepare('SELECT company_bin, amount, term, purpose, name, email, phone, files_count, tax_status, tax_report_text, fs_status, fs_report_text, fs_report_structured, tax_missing_periods, fs_missing_periods, docs_overview_json, docs_overview_text FROM reports WHERE session_id = ?').get(sessionId)

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
                docsOverviewJson: localReport?.docs_overview_json ?? null,
                docsOverviewText: localReport?.docs_overview_text ?? null,
              }
            })
          }
        } catch (ikap2Error) {
          console.warn(`⚠️ Не удалось получить отчет от ikap2 для сессии ${sessionId}:`, ikap2Error.message)
        }
      }

      // Если ikap2 не используется или вернул ошибку — работаем только с локальной БД
      const report = await db.prepare(`
        SELECT 
          session_id, 
          company_bin, 
          amount, 
          term, 
          purpose, 
          name, 
          email, 
          phone, 
          status, 
          report_text, 
          report_structured, 
          files_count, 
          created_at, 
          completed_at,
          tax_status,
          tax_report_text,
          tax_missing_periods,
          fs_status,
          fs_report_text,
          fs_report_structured,
          fs_missing_periods,
          docs_overview_json,
          docs_overview_text
        FROM reports 
        WHERE session_id = ?
      `).get(sessionId)

      if (!report) {
        return res.status(404).json({
          ok: false,
          message: 'Отчет не найден',
        })
      }

      // Гарантируем, что текст отчёта в читаемом формате
      const safeReport = transactionProcessor.ensureHumanReadableReportText({ ...report })

      return res.json({
        ok: true,
        report: {
          sessionId: safeReport.session_id,
          bin: safeReport.company_bin,
          amount: safeReport.amount,
          term: safeReport.term,
          purpose: safeReport.purpose,
          name: safeReport.name,
          email: safeReport.email,
          phone: safeReport.phone,
          filesCount: safeReport.files_count,
          status: safeReport.status,
          reportText: safeReport.report_text,
          reportStructured: safeReport.report_structured,
          createdAt: safeReport.created_at,
          completedAt: safeReport.completed_at,
          taxStatus: safeReport.tax_status,
          taxReportText: safeReport.tax_report_text,
          taxMissing: safeReport.tax_missing_periods,
          fsStatus: safeReport.fs_status,
          fsReportText: safeReport.fs_report_text,
          fsReportStructured: safeReport.fs_report_structured,
          fsMissing: safeReport.fs_missing_periods,
          docsOverviewJson: safeReport.docs_overview_json,
          docsOverviewText: safeReport.docs_overview_text,
        }
      })
    } catch (error) {
      console.error('❌ Ошибка при получении отчета:', error)
      return res.status(500).json({
        ok: false,
        message: 'Ошибка сервера',
      })
    }
  })

  // Эндпоинт для удаления заявки
  router.delete('/:sessionId', async (req, res) => {
    const { sessionId } = req.params
    console.log(`🗑️ [${new Date().toISOString()}] DELETE запрос на удаление заявки: ${sessionId}`)
    console.log(`🗑️ Request method: ${req.method}, URL: ${req.url}`)

    try {
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
      }

      return res.json({
        ok: true,
        message: 'Заявка и связанные данные удалены',
      })
    } catch (error) {
      console.error(`❌ Общая ошибка при удалении заявки:`, error.message)
      return res.status(500).json({
        ok: false,
        message: 'Ошибка сервера при удалении заявки',
      })
    }
  })

  // Эндпоинт для получения списка всех заявок (для менеджера)
  router.get('/', async (req, res) => {
    try {
      const reports = await db.prepare(`
        SELECT session_id, company_bin, amount, term, purpose, name, email, phone, 
               status, files_count, created_at, completed_at,
               tax_status, fs_status, report_text, report_structured,
               openai_response_id, openai_status, tax_report_text, fs_report_text, fs_report_structured,
               tax_missing_periods, fs_missing_periods,
               docs_overview_json, docs_overview_text
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
          createdAt: r.created_at,
          completedAt: r.completed_at,
          reportText: r.report_text,
          reportStructured: r.report_structured,
          openaiResponseId: r.openai_response_id,
          openaiStatus: r.openai_status,
          taxReportText: r.tax_report_text,
          fsReportText: r.fs_report_text,
          fsReportStructured: r.fs_report_structured,
          taxMissing: r.tax_missing_periods,
          fsMissing: r.fs_missing_periods,
          docsOverviewJson: r.docs_overview_json,
          docsOverviewText: r.docs_overview_text,
        })),
      })
    } catch (error) {
      console.error('❌ Ошибка при получении списка заявок:', error)
      return res.status(500).json({
        ok: false,
        message: 'Ошибка сервера',
      })
    }
  })

  return router
}

module.exports = {
  createReportsRouter,
}

