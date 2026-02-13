function createSessionsRouter({ db, getMessagesFromDB, normalizeFileName }) {
  const express = require('express')
  const router = express.Router()

  // Эндпоинт для восстановления истории сессии
  router.get('/:sessionId/history', async (req, res) => {
    const { sessionId } = req.params
    console.log(`📖 Запрос истории сессии: ${sessionId}`)

    try {
      // Получаем историю из БД
      const history = await getMessagesFromDB(sessionId)

      if (!history || history.length === 0) {
        console.log(`⚠️ История не найдена в БД для сессии: ${sessionId}`)
        return res.status(404).json({
          ok: false,
          message: 'Сессия не найдена',
        })
      }

      // Преобразуем историю в формат сообщений для фронтенда
      const messages = []

      // Добавляем приветственное сообщение
      messages.push({
        id: 1,
        text: 'Здравствуйте, как я могу к Вам обращаться?',
        sender: 'bot',
        timestamp: new Date(),
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
            text,
            sender: 'user',
            timestamp: new Date(),
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
              text,
              sender: 'bot',
              timestamp: new Date(),
            })
          }
        }
      })

      console.log(`✅ История восстановлена из БД: ${messages.length} сообщений`)
      return res.json({
        ok: true,
        messages,
      })
    } catch (error) {
      console.error('❌ Ошибка восстановления истории:', error)
      return res.status(500).json({
        ok: false,
        message: 'Ошибка сервера',
      })
    }
  })

  // Эндпоинт для получения файлов сессии
  router.get('/:sessionId/files', async (req, res) => {
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
          uploadedAt: f.uploaded_at,
        })),
      })
    } catch (error) {
      console.error('❌ Ошибка получения файлов:', error)
      return res.status(500).json({
        ok: false,
        message: 'Ошибка сервера',
      })
    }
  })

  return router
}

module.exports = {
  createSessionsRouter,
}

