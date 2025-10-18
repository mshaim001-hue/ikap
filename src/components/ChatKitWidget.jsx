import React, { useState, useEffect } from 'react'
import { ChatKit, useChatKit } from '@openai/chatkit-react'
import chatkitService from '../services/chatkitService'
import './ChatKitWidget.css'

const ChatKitWidget = () => {
  const [deviceId] = useState(() => chatkitService.generateDeviceId())
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)

  const { control } = useChatKit({
    api: {
      async getClientSecret(existing) {
        try {
          if (existing) {
            // Обновляем существующую сессию
            return await chatkitService.refreshSession(existing)
          }
          
          // Создаем новую сессию
          return await chatkitService.createSession(deviceId)
        } catch (err) {
          console.error('Failed to get client secret:', err)
          setError('Не удалось подключиться к чат-боту. Проверьте настройки API.')
          throw err
        }
      }
    }
  })

  // Debug: подписка на события ChatKit для логирования
  useEffect(() => {
    const onError = (e) => console.error('[chatkit.error]', e.detail || e)
    const onStart = () => console.log('[chatkit.response.start]')
    const onEnd = () => console.log('[chatkit.response.end]')
    const onThread = (e) => console.log('[chatkit.thread.change]', e.detail)
    const onLog = (e) => console.log('[chatkit.log]', e.detail)

    window.addEventListener('chatkit.error', onError)
    window.addEventListener('chatkit.response.start', onStart)
    window.addEventListener('chatkit.response.end', onEnd)
    window.addEventListener('chatkit.thread.change', onThread)
    window.addEventListener('chatkit.log', onLog)

    return () => {
      window.removeEventListener('chatkit.error', onError)
      window.removeEventListener('chatkit.response.start', onStart)
      window.removeEventListener('chatkit.response.end', onEnd)
      window.removeEventListener('chatkit.thread.change', onThread)
      window.removeEventListener('chatkit.log', onLog)
    }
  }, [])

  useEffect(() => {
    // Имитируем загрузку для плавного появления
    const timer = setTimeout(() => {
      setIsLoading(false)
    }, 1000)

    return () => clearTimeout(timer)
  }, [])

  if (isLoading) {
    return (
      <div className="chatkit-loading">
        <div className="loading-spinner"></div>
        <p>Загружаем чат-бота...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="chatkit-error">
        <h3>Ошибка подключения</h3>
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>
          Попробовать снова
        </button>
      </div>
    )
  }

  return (
    <div className="chatkit-container">
      <ChatKit 
        control={control} 
        className="chatkit-widget"
      />
    </div>
  )
}

export default ChatKitWidget

