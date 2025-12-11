import React, { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Save, RefreshCw } from 'lucide-react'
import { getApiUrl } from '../utils/api'
import './Settings.css'

const Settings = () => {
  const [instructions, setInstructions] = useState('')
  const [model, setModel] = useState('gpt-5-mini')
  const [mcpConfig, setMcpConfig] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState({ type: '', text: '' })

  const agentName = 'Information Agent'

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      setLoading(true)
      const response = await fetch(getApiUrl(`/api/agent-settings/${agentName}`))
      if (response.ok) {
        const data = await response.json()
        if (data.ok && data.settings) {
          setInstructions(data.settings.instructions || '')
          setModel(data.settings.model || 'gpt-5-mini')
          setMcpConfig(data.settings.mcpConfig ? JSON.stringify(data.settings.mcpConfig, null, 2) : '')
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

      <div className="settings-content">
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
    </div>
  )
}

export default Settings

