const fs = require('fs')
const path = require('path')

function createAgentSettingsRouter({
  db,
  getAgentSettings,
  initMcpServerFromDb,
  mcpContext,
}) {
  const express = require('express')
  const router = express.Router()

  // GET /api/agent-settings/:agentName/mcp-server
  router.get('/:agentName/mcp-server', async (req, res) => {
    try {
      let agentName = req.params.agentName

      console.log(`🔍 [MCP Route] Получен запрос, agentName из params: "${agentName}"`)
      console.log(`🔍 [MCP Route] Полный URL: ${req.originalUrl || req.url}`)

      try {
        agentName = decodeURIComponent(agentName)
      } catch (e) {
        console.warn('⚠️ Не удалось декодировать agentName, используем как есть:', agentName)
      }

      if (agentName === 'information-agent') {
        agentName = 'Information Agent'
      }

      console.log(`📄 Запрос кода MCP сервера для агента: "${agentName}"`)

      if (agentName !== 'Information Agent') {
        return res.status(404).json({
          ok: false,
          message: 'MCP сервер доступен только для Information Agent',
        })
      }

      const settings = await getAgentSettings(agentName)

      if (!settings || !settings.mcp_server_code) {
        const fallbackPath = path.join(__dirname, '..', 'mcp', 'ikap-info-server.js')
        if (fs.existsSync(fallbackPath)) {
          console.log('📄 Загружаем MCP сервер из файла (код в БД отсутствует)')
          const mcpServerContent = fs.readFileSync(fallbackPath, 'utf8')
          return res.json({
            ok: true,
            content: mcpServerContent,
            filename: 'ikap-info-server.js',
          })
        }
        return res.status(404).json({
          ok: false,
          message: 'Код MCP сервера не найден в БД',
        })
      }

      console.log(`✅ Код MCP сервера загружен из БД, размер: ${settings.mcp_server_code.length} символов`)

      return res.json({
        ok: true,
        content: settings.mcp_server_code,
        filename: 'ikap-info-server.js',
      })
    } catch (error) {
      console.error('❌ Ошибка получения MCP сервера:', error)
      return res.status(500).json({
        ok: false,
        message: `Ошибка сервера при получении MCP сервера: ${error.message}`,
      })
    }
  })

  // PUT /api/agent-settings/:agentName/mcp-server
  router.put('/:agentName/mcp-server', async (req, res) => {
    try {
      let agentName = req.params.agentName

      try {
        agentName = decodeURIComponent(agentName)
      } catch (e) {
        console.warn('⚠️ Не удалось декодировать agentName, используем как есть:', agentName)
      }

      if (agentName === 'information-agent') {
        agentName = 'Information Agent'
      }

      const { content } = req.body
      console.log(`💾 Сохранение кода MCP сервера для агента: "${agentName}"`)

      if (agentName !== 'Information Agent') {
        return res.status(404).json({
          ok: false,
          message: 'MCP сервер доступен только для Information Agent',
        })
      }

      if (!content || typeof content !== 'string') {
        return res.status(400).json({
          ok: false,
          message: 'Поле content обязательно и должно быть строкой',
        })
      }

      const updateMcpCode = db.prepare(`
        UPDATE agent_settings 
        SET mcp_server_code = ?, updated_at = CURRENT_TIMESTAMP
        WHERE agent_name = ?
      `)
      await updateMcpCode.run(content, agentName)
      console.log(`✅ Код MCP сервера сохранен в БД, размер: ${content.length} символов`)

      try {
        if (mcpContext.ikapInfoMcpServer?.close) {
          await mcpContext.ikapInfoMcpServer.close()
        }
        if (mcpContext.tempMcpServerPath && fs.existsSync(mcpContext.tempMcpServerPath)) {
          fs.unlinkSync(mcpContext.tempMcpServerPath)
        }
        await initMcpServerFromDb()
      } catch (e) {
        console.warn('⚠️ Не удалось перезапустить MCP сервер, будет перезапущен при следующем использовании:', e.message)
      }

      mcpContext.informationAgent = null
      mcpContext.agentCacheTimestamp = 0
      console.log('🔄 Кэш Information Agent сброшен, MCP сервер обновлен')

      return res.json({
        ok: true,
        message: 'Код MCP сервера успешно сохранен в БД',
      })
    } catch (error) {
      console.error('❌ Ошибка сохранения MCP сервера:', error)
      return res.status(500).json({
        ok: false,
        message: `Ошибка сервера при сохранении MCP сервера: ${error.message}`,
      })
    }
  })

  // GET /api/agent-settings/:agentName
  router.get('/:agentName', async (req, res) => {
    const { agentName } = req.params
    console.log(`📋 Запрос настроек агента: ${agentName}`)

    try {
      const settings = await getAgentSettings(agentName)

      if (!settings) {
        return res.status(404).json({
          ok: false,
          message: 'Настройки агента не найдены',
        })
      }

      let mcpConfig = null
      if (settings.mcp_config) {
        try {
          if (typeof settings.mcp_config === 'string') {
            mcpConfig = JSON.parse(settings.mcp_config)
          } else if (typeof settings.mcp_config === 'object') {
            mcpConfig = settings.mcp_config
          }
        } catch (e) {
          console.error('⚠️ Ошибка парсинга mcp_config:', e)
        }
      }

      let modelSettings = null
      if (settings.model_settings) {
        try {
          if (typeof settings.model_settings === 'string') {
            modelSettings = JSON.parse(settings.model_settings)
          } else if (typeof settings.model_settings === 'object') {
            modelSettings = settings.model_settings
          }
        } catch (e) {
          console.error('⚠️ Ошибка парсинга model_settings:', e)
        }
      }

      return res.json({
        ok: true,
        settings: {
          agentName,
          instructions: settings.instructions,
          role: settings.role || 'Информационный консультант',
          functionality: settings.functionality || 'Отвечает на вопросы о платформе iKapitalist',
          mcpConfig,
          mcpServerCode: settings.mcp_server_code || null,
          model: settings.model,
          modelSettings,
          defaultAnnualRate: settings.default_annual_rate || 0.3,
        },
      })
    } catch (error) {
      console.error('❌ Ошибка получения настроек агента:', error)
      return res.status(500).json({
        ok: false,
        message: 'Ошибка сервера при получении настроек',
      })
    }
  })

  // PUT /api/agent-settings/:agentName
  router.put('/:agentName', async (req, res) => {
    const { agentName } = req.params
    const { instructions, role, functionality, mcpConfig, model, modelSettings, defaultAnnualRate } = req.body
    console.log(`💾 Обновление настроек агента: ${agentName}`)

    try {
      if (!instructions || typeof instructions !== 'string') {
        return res.status(400).json({
          ok: false,
          message: 'Поле instructions обязательно и должно быть строкой',
        })
      }

      let annualRateValue = defaultAnnualRate !== undefined ? parseFloat(defaultAnnualRate) : null
      if (annualRateValue !== null && (isNaN(annualRateValue) || annualRateValue <= 0 || annualRateValue > 1)) {
        return res.status(400).json({
          ok: false,
          message: 'Годовая ставка должна быть числом от 0 до 1 (например, 0.3 для 30%)',
        })
      }

      const updateSettings = db.prepare(`
        INSERT INTO agent_settings (agent_name, instructions, role, functionality, mcp_config, model, model_settings, default_annual_rate, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (agent_name) DO UPDATE SET
          instructions = EXCLUDED.instructions,
          role = EXCLUDED.role,
          functionality = EXCLUDED.functionality,
          mcp_config = EXCLUDED.mcp_config,
          model = EXCLUDED.model,
          model_settings = EXCLUDED.model_settings,
          default_annual_rate = COALESCE(EXCLUDED.default_annual_rate, agent_settings.default_annual_rate),
          updated_at = CURRENT_TIMESTAMP
      `)

      await updateSettings.run(
        agentName,
        instructions,
        role || null,
        functionality || null,
        mcpConfig ? JSON.stringify(mcpConfig) : null,
        model || 'gpt-5-mini',
        modelSettings ? JSON.stringify(modelSettings) : null,
        annualRateValue,
      )

      console.log(`✅ Настройки агента ${agentName} обновлены`)

      return res.json({
        ok: true,
        message: 'Настройки агента обновлены',
      })
    } catch (error) {
      console.error('❌ Ошибка обновления настроек агента:', error)
      return res.status(500).json({
        ok: false,
        message: 'Ошибка сервера при обновлении настроек',
      })
    }
  })

  return router
}

module.exports = {
  createAgentSettingsRouter,
}

