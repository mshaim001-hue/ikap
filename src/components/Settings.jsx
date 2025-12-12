import React, { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Save, RefreshCw, FileCode } from 'lucide-react'
import { getApiUrl } from '../utils/api'
import './Settings.css'

const Settings = () => {
  const [agentName, setAgentName] = useState('Information Agent')
  const [role, setRole] = useState('Информационный консультант')
  const [functionality, setFunctionality] = useState('Отвечает на вопросы о платформе iKapitalist, помогает пользователям понять возможности платформы и подводит к подаче заявки')
  const [instructions, setInstructions] = useState('')
  const [model, setModel] = useState('gpt-5-mini')
  const [mcpConfig, setMcpConfig] = useState('')
  const [mcpServerContent, setMcpServerContent] = useState('')
  const [mcpServerLoading, setMcpServerLoading] = useState(false)
  const [mcpServerSaving, setMcpServerSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('general') // 'general' или 'mcp'
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState({ type: '', text: '' })

  useEffect(() => {
    loadSettings()
    loadMcpServer()
  }, [])

  const loadSettings = async () => {
    try {
      setLoading(true)
      const response = await fetch(getApiUrl(`/api/agent-settings/${agentName}`))
      if (response.ok) {
        const data = await response.json()
        if (data.ok && data.settings) {
          setInstructions(data.settings.instructions || '')
          // Используем значения из БД, если они есть, иначе дефолтные
          setRole(data.settings.role || 'Информационный консультант')
          setFunctionality(data.settings.functionality || 'Отвечает на вопросы о платформе iKapitalist, помогает пользователям понять возможности платформы и подводит к подаче заявки')
          setModel(data.settings.model || 'gpt-5-mini')
          setMcpConfig(data.settings.mcpConfig ? JSON.stringify(data.settings.mcpConfig, null, 2) : '')
        } else {
          // Если настройки не найдены, используем дефолтные значения
          setRole('Информационный консультант')
          setFunctionality('Отвечает на вопросы о платформе iKapitalist, помогает пользователям понять возможности платформы и подводит к подаче заявки')
        }
      } else {
        setMessage({ type: 'error', text: 'Не удалось загрузить настройки' })
      }
    } catch (error) {
      console.error('Ошибка загрузки настроек:', error)
      setMessage({ type: 'error', text: 'Ошибка загрузки настроек' })
    } finally {
      setLoading(false)
    }
  }

  const loadMcpServer = async () => {
    try {
      setMcpServerLoading(true)
      setMessage({ type: '', text: '' })
      
      // Используем slug вместо полного названия для избежания проблем с пробелами
      // Information Agent -> information-agent
      const agentSlug = agentName.toLowerCase().replace(/\s+/g, '-')
      const response = await fetch(getApiUrl(`/api/agent-settings/${agentSlug}/mcp-server`))
      
      if (response.ok) {
        const data = await response.json()
        if (data.ok && data.content) {
          setMcpServerContent(data.content)
          console.log('✅ MCP сервер успешно загружен')
        } else {
          console.warn('MCP сервер не найден или пуст:', data)
          setMessage({ type: 'error', text: data.message || 'Не удалось загрузить MCP сервер' })
        }
      } else {
        const errorData = await response.json().catch(() => ({}))
        console.error('❌ Ошибка загрузки MCP сервера:', response.status, errorData)
        const errorMessage = errorData.message || `Ошибка ${response.status}: Не удалось загрузить MCP сервер`
        setMessage({ type: 'error', text: errorMessage })
      }
    } catch (error) {
      console.error('❌ Ошибка загрузки MCP сервера:', error)
      setMessage({ type: 'error', text: 'Ошибка загрузки MCP сервера: ' + error.message })
    } finally {
      setMcpServerLoading(false)
    }
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      setMessage({ type: '', text: '' })

      let parsedMcpConfig = null
      if (mcpConfig.trim()) {
        try {
          parsedMcpConfig = JSON.parse(mcpConfig)
        } catch (e) {
          setMessage({ type: 'error', text: 'Неверный формат JSON для MCP конфигурации' })
          setSaving(false)
          return
        }
      }

      const response = await fetch(getApiUrl(`/api/agent-settings/${agentName}`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          instructions,
          role,
          functionality,
          mcpConfig: parsedMcpConfig,
          model,
          modelSettings: { store: true }
        })
      })

      if (response.ok) {
        const data = await response.json()
        if (data.ok) {
          setMessage({ type: 'success', text: 'Настройки успешно сохранены' })
          setTimeout(() => setMessage({ type: '', text: '' }), 3000)
        } else {
          setMessage({ type: 'error', text: data.message || 'Ошибка сохранения' })
        }
      } else {
        const data = await response.json()
        setMessage({ type: 'error', text: data.message || 'Ошибка сохранения' })
      }
    } catch (error) {
      console.error('Ошибка сохранения настроек:', error)
      setMessage({ type: 'error', text: 'Ошибка сохранения настроек' })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveMcpServer = async () => {
    try {
      setMcpServerSaving(true)
      setMessage({ type: '', text: '' })

      // Используем slug вместо полного названия для избежания проблем с пробелами
      const agentSlug = agentName.toLowerCase().replace(/\s+/g, '-')
      const response = await fetch(getApiUrl(`/api/agent-settings/${agentSlug}/mcp-server`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: mcpServerContent
        })
      })

      if (response.ok) {
        const data = await response.json()
        if (data.ok) {
          setMessage({ type: 'success', text: 'MCP сервер успешно сохранен' })
          setTimeout(() => setMessage({ type: '', text: '' }), 3000)
        } else {
          setMessage({ type: 'error', text: data.message || 'Ошибка сохранения MCP сервера' })
        }
      } else {
        const data = await response.json()
        setMessage({ type: 'error', text: data.message || 'Ошибка сохранения MCP сервера' })
      }
    } catch (error) {
      console.error('Ошибка сохранения MCP сервера:', error)
      setMessage({ type: 'error', text: 'Ошибка сохранения MCP сервера' })
    } finally {
      setMcpServerSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="settings-container">
        <div className="settings-loading">
          <RefreshCw className="spinner" size={24} />
          <span>Загрузка настроек...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-container">
      <div className="settings-header">
        <SettingsIcon size={24} />
        <h1>Настройки информационного агента</h1>
      </div>

      {message.text && (
        <div className={`settings-message ${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="settings-tabs">
        <button
          className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          <SettingsIcon size={16} />
          Основные настройки
        </button>
        <button
          className={`settings-tab ${activeTab === 'mcp' ? 'active' : ''}`}
          onClick={() => setActiveTab('mcp')}
        >
          <FileCode size={16} />
          MCP Сервер
        </button>
      </div>

      {activeTab === 'general' && (
        <div className="settings-content">
          <div className="settings-section">
            <label htmlFor="agentName">Название агента</label>
            <input
              id="agentName"
              type="text"
              value={agentName}
              disabled
              className="settings-input settings-input-disabled"
            />
            <div className="settings-hint">
              Название агента нельзя изменить
            </div>
          </div>

          <div className="settings-section">
            <label htmlFor="role">Роль агента</label>
            <input
              id="role"
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="settings-input"
              placeholder="Например: Информационный консультант"
            />
            <div className="settings-hint">
              Краткое описание роли агента в системе
            </div>
          </div>

          <div className="settings-section">
            <label htmlFor="functionality">Функционал агента</label>
            <textarea
              id="functionality"
              value={functionality}
              onChange={(e) => setFunctionality(e.target.value)}
              className="settings-textarea"
              rows={4}
              placeholder="Опишите, что делает агент..."
            />
            <div className="settings-hint">
              Подробное описание функционала и возможностей агента
            </div>
          </div>

          <div className="settings-section">
            <label htmlFor="model">Модель</label>
            <select
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="settings-input"
            >
              <option value="gpt-5-mini">gpt-5-mini</option>
              <option value="gpt-5">gpt-5</option>
              <option value="gpt-4o">gpt-4o</option>
              <option value="gpt-4o-mini">gpt-4o-mini</option>
            </select>
            <div className="settings-hint">
              Модель OpenAI, используемая агентом
            </div>
          </div>

          <div className="settings-section">
            <label htmlFor="instructions">Инструкции (промпт) агента</label>
            <textarea
              id="instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="settings-textarea"
              rows={20}
              placeholder="Введите инструкции для информационного агента..."
            />
            <div className="settings-hint">
              Это промпт, который определяет поведение информационного агента. Агент будет использовать эти инструкции для общения с пользователями.
            </div>
          </div>

          <div className="settings-section">
            <label htmlFor="mcpConfig">Конфигурация MCP сервера (JSON)</label>
            <textarea
              id="mcpConfig"
              value={mcpConfig}
              onChange={(e) => setMcpConfig(e.target.value)}
              className="settings-textarea settings-code"
              rows={15}
              placeholder='{\n  "sections": {},\n  "tools": []\n}'
            />
            <div className="settings-hint">
              Конфигурация MCP сервера в формате JSON. Оставьте пустым, если не нужно изменять.
            </div>
          </div>

          <div className="settings-actions">
            <button
              onClick={handleSave}
              disabled={saving}
              className="settings-save-btn"
            >
              {saving ? (
                <>
                  <RefreshCw className="spinner" size={16} />
                  Сохранение...
                </>
              ) : (
                <>
                  <Save size={16} />
                  Сохранить настройки
                </>
              )}
            </button>
            <button
              onClick={loadSettings}
              disabled={loading || saving}
              className="settings-reload-btn"
            >
              <RefreshCw size={16} />
              Обновить
            </button>
          </div>
        </div>
      )}

      {activeTab === 'mcp' && (
        <div className="settings-content">
          <div className="settings-section">
            <label htmlFor="mcpServer">Код MCP сервера (ikap-info-server.js)</label>
            {mcpServerLoading ? (
              <div className="settings-loading-inline">
                <RefreshCw className="spinner" size={16} />
                <span>Загрузка MCP сервера...</span>
              </div>
            ) : (
              <textarea
                id="mcpServer"
                value={mcpServerContent}
                onChange={(e) => setMcpServerContent(e.target.value)}
                className="settings-textarea settings-code"
                rows={30}
                placeholder="Код MCP сервера..."
              />
            )}
            <div className="settings-hint">
              Редактирование кода MCP сервера. Будьте осторожны при изменении - это может повлиять на работу агента.
            </div>
          </div>

          <div className="settings-actions">
            <button
              onClick={handleSaveMcpServer}
              disabled={mcpServerSaving || mcpServerLoading}
              className="settings-save-btn"
            >
              {mcpServerSaving ? (
                <>
                  <RefreshCw className="spinner" size={16} />
                  Сохранение...
                </>
              ) : (
                <>
                  <Save size={16} />
                  Сохранить MCP сервер
                </>
              )}
            </button>
            <button
              onClick={loadMcpServer}
              disabled={mcpServerLoading || mcpServerSaving}
              className="settings-reload-btn"
            >
              <RefreshCw size={16} />
              Обновить
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default Settings
