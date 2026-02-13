function createMcpSectionsRouter({ db, initMcpServerFromDb, mcpContext }) {
  const express = require('express')
  const fs = require('fs')
  const router = express.Router()

  // GET /api/mcp-sections
  router.get('/', async (req, res) => {
    try {
      const sectionsQuery = db.prepare(`
        SELECT id, section_id, title, content, created_at, updated_at
        FROM mcp_sections
        ORDER BY section_id
      `)
      const sections = await sectionsQuery.all()

      return res.json({
        ok: true,
        sections: sections.map(s => ({
          id: s.id,
          sectionId: s.section_id,
          title: s.title,
          content: s.content,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
        })),
      })
    } catch (error) {
      console.error('❌ Ошибка получения разделов MCP:', error)
      return res.status(500).json({
        ok: false,
        message: `Ошибка сервера при получении разделов: ${error.message}`,
      })
    }
  })

  // POST /api/mcp-sections
  router.post('/', async (req, res) => {
    try {
      const { title, content } = req.body

      if (!title || !content) {
        return res.status(400).json({
          ok: false,
          message: 'Поля title и content обязательны',
        })
      }

      const sectionId = title
        .toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 50)

      if (!sectionId) {
        return res.status(400).json({
          ok: false,
          message: 'Не удалось сгенерировать section_id из title',
        })
      }

      const checkQuery = db.prepare('SELECT id FROM mcp_sections WHERE section_id = ?')
      const existing = await checkQuery.get(sectionId)

      if (existing) {
        return res.status(409).json({
          ok: false,
          message: `Раздел с идентификатором "${sectionId}" уже существует`,
        })
      }

      const insertSection = db.prepare(`
        INSERT INTO mcp_sections (section_id, title, content)
        VALUES (?, ?, ?)
      `)
      await insertSection.run(sectionId, title, content)

      console.log(`✅ Добавлен новый раздел MCP: ${sectionId} (${title})`)

      try {
        if (mcpContext.ikapInfoMcpServer?.close) {
          await mcpContext.ikapInfoMcpServer.close()
        }
        if (mcpContext.tempMcpServerPath && fs.existsSync(mcpContext.tempMcpServerPath)) {
          fs.unlinkSync(mcpContext.tempMcpServerPath)
        }
        await initMcpServerFromDb()
        mcpContext.informationAgent = null
        mcpContext.agentCacheTimestamp = 0
        console.log('🔄 MCP сервер перезапущен с новым разделом')
      } catch (e) {
        console.warn('⚠️ Не удалось перезапустить MCP сервер:', e.message)
      }

      return res.json({
        ok: true,
        message: 'Раздел успешно добавлен',
        section: {
          sectionId,
          title,
          content,
        },
      })
    } catch (error) {
      console.error('❌ Ошибка добавления раздела MCP:', error)
      return res.status(500).json({
        ok: false,
        message: `Ошибка сервера при добавлении раздела: ${error.message}`,
      })
    }
  })

  // DELETE /api/mcp-sections/:sectionId
  router.delete('/:sectionId', async (req, res) => {
    try {
      const { sectionId } = req.params

      const deleteSection = db.prepare('DELETE FROM mcp_sections WHERE section_id = ?')
      const result = await deleteSection.run(sectionId)

      if (result.changes === 0) {
        return res.status(404).json({
          ok: false,
          message: 'Раздел не найден',
        })
      }

      console.log(`✅ Удален раздел MCP: ${sectionId}`)

      try {
        if (mcpContext.ikapInfoMcpServer?.close) {
          await mcpContext.ikapInfoMcpServer.close()
        }
        if (mcpContext.tempMcpServerPath && fs.existsSync(mcpContext.tempMcpServerPath)) {
          fs.unlinkSync(mcpContext.tempMcpServerPath)
        }
        await initMcpServerFromDb()
        mcpContext.informationAgent = null
        mcpContext.agentCacheTimestamp = 0
        console.log('🔄 MCP сервер перезапущен после удаления раздела')
      } catch (e) {
        console.warn('⚠️ Не удалось перезапустить MCP сервер:', e.message)
      }

      return res.json({
        ok: true,
        message: 'Раздел успешно удален',
      })
    } catch (error) {
      console.error('❌ Ошибка удаления раздела MCP:', error)
      return res.status(500).json({
        ok: false,
        message: `Ошибка сервера при удалении раздела: ${error.message}`,
      })
    }
  })

  return router
}

module.exports = {
  createMcpSectionsRouter,
}

