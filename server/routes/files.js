function createFilesRouter({ db, normalizeFileName }) {
  const express = require('express')
  const router = express.Router()

  // Эндпоинт для скачивания файла из локального хранилища
  router.get('/:fileId/download', async (req, res) => {
    const { fileId } = req.params
    console.log(`📥 Запрос скачивания файла: ${fileId}`)

    try {
      // Получаем файл из БД (включая file_data)
      const getFile = db.prepare(`
        SELECT file_id, original_name, mime_type, file_data
        FROM files 
        WHERE file_id = ?
      `)
      const file = await getFile.get(fileId)

      if (!file) {
        console.log(`⚠️ Файл не найден в БД: ${fileId}`)
        return res.status(404).json({
          ok: false,
          message: 'Файл не найден',
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

      if (!buffer) {
        return res.status(404).json({
          ok: false,
          message: 'Файл не найден в БД',
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
        message: 'Ошибка сервера при скачивании файла',
      })
    }
  })

  return router
}

module.exports = {
  createFilesRouter,
}

