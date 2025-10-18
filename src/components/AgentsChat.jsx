import React, { useState, useRef, useEffect } from 'react'
import { Send, Bot, User, Loader, Paperclip } from 'lucide-react'
import PrivacyPolicyModal from './PrivacyPolicyModal'
import './AgentsChat.css'

const AgentsChat = () => {
  const [messages, setMessages] = useState([
    {
      id: 1,
      text: "Здравствуйте, как я могу к вам обращаться?",
      sender: 'bot',
      timestamp: new Date()
    }
  ])
  const [inputMessage, setInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [sessionId, setSessionId] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [showPrivacyModal, setShowPrivacyModal] = useState(false)
  const [dialogState, setDialogState] = useState('greeting') // greeting, name_collected, terms_accepted, data_collection
  const [userName, setUserName] = useState('')
  const [isCompleted, setIsCompleted] = useState(false) // Флаг завершения заявки
  const [showReportModal, setShowReportModal] = useState(false) // Модальное окно отчета
  const [reportData, setReportData] = useState(null) // Данные отчета
  const [loadingReport, setLoadingReport] = useState(false) // Загрузка отчета
  const fileInputRef = useRef(null)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleFileSelect = (event) => {
    const file = event.target.files[0]
    if (file) {
      setSelectedFile(file)
      setInputMessage(`Прикрепляю файл: ${file.name}`)
    }
  }

  const handleSendMessage = async () => {
    if ((!inputMessage.trim() && !selectedFile) || isLoading) return

    console.log('🔍 Текущее состояние диалога:', dialogState)
    console.log('📝 Сообщение пользователя:', inputMessage.trim())

    const userMessage = {
      id: Date.now(),
      text: inputMessage + (selectedFile ? ` (файл: ${selectedFile.name})` : ''),
      sender: 'user',
      timestamp: new Date()
    }

    setMessages(prev => [...prev, userMessage])
    
    const messageText = inputMessage.trim()
    
    // Обработка состояний диалога
    if (dialogState === 'greeting') {
      setUserName(messageText)
      setDialogState('name_collected')
      
      const botMessage = {
        id: Date.now() + 1,
        text: `Здравствуйте, ${messageText}. Вы находитесь на платформе по привлечению денег для вашего бизнеса. Прежде чем продолжить, пожалуйста, примите условия платформы.`,
        sender: 'bot',
        timestamp: new Date(),
        showTermsButton: true
      }
      
      setMessages(prev => [...prev, botMessage])
      setInputMessage('')
      setSelectedFile(null)
      return
    }
    
    if (dialogState === 'name_collected') {
      // Пользователь не должен отвечать здесь - модальное окно должно быть открыто
      return
    }
    
    if (dialogState === 'terms_accepted') {
      console.log('🔄 Переходим в режим сбора данных')
      setDialogState('data_collection')
      
      // Сразу отправляем в агента после изменения состояния
      console.log('🚀 Отправляем в агента:', messageText)
      console.log('🆔 SessionId:', sessionId)
      console.log('📎 Файл:', selectedFile?.name)
      
      setInputMessage('')
      setSelectedFile(null)
      setIsLoading(true)

      try {
        // Подготавливаем FormData для отправки файла
        const formData = new FormData()
        formData.append('text', messageText)
        if (sessionId) formData.append('sessionId', sessionId)
        if (selectedFile) formData.append('file', selectedFile)

        console.log('📤 Отправляем запрос к серверу...')
        
        // call backend server
        const resp = await fetch('/api/agents/run', {
          method: 'POST',
          body: formData
        })
        
        console.log('📥 Получен ответ от сервера:', resp.status)
        const result = await resp.json()
        console.log('📋 Результат:', result)
        
        // Сохраняем sessionId для следующих запросов
        if (result.sessionId && !sessionId) {
          setSessionId(result.sessionId)
          console.log('🆔 Новый sessionId:', result.sessionId)
        }
        
        const botMessage = {
          id: Date.now() + 1,
          text: result.message,
          sender: 'bot',
          timestamp: new Date(),
          data: result.data
        }

        console.log('💬 Добавляем сообщение бота:', result.message)
        setMessages(prev => [...prev, botMessage])
      } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error)
        const errorMessage = {
          id: Date.now() + 1,
          text: "Извините, произошла ошибка. Попробуйте еще раз.",
          sender: 'bot',
          timestamp: new Date()
        }
        setMessages(prev => [...prev, errorMessage])
      } finally {
        setIsLoading(false)
      }
      return
    }
    
    // Если мы в режиме сбора данных, отправляем в агента
    if (dialogState === 'data_collection') {
      console.log('🚀 Отправляем в агента:', messageText)
      console.log('🆔 SessionId:', sessionId)
      console.log('📎 Файл:', selectedFile?.name)
      
      setInputMessage('')
      setSelectedFile(null)
      setIsLoading(true)

      try {
        // Подготавливаем FormData для отправки файла
        const formData = new FormData()
        formData.append('text', messageText)
        if (sessionId) formData.append('sessionId', sessionId)
        if (selectedFile) formData.append('file', selectedFile)

        console.log('📤 Отправляем запрос к серверу...')
        
        // call backend server
        const resp = await fetch('/api/agents/run', {
          method: 'POST',
          body: formData
        })
        
        console.log('📥 Получен ответ от сервера:', resp.status)
        const result = await resp.json()
        console.log('📋 Результат:', result)
        
        // Сохраняем sessionId для следующих запросов
        if (result.sessionId && !sessionId) {
          setSessionId(result.sessionId)
          console.log('🆔 Новый sessionId:', result.sessionId)
        }
        
        const botMessage = {
          id: Date.now() + 1,
          text: result.message,
          sender: 'bot',
          timestamp: new Date(),
          data: result.data
        }

        console.log('💬 Добавляем сообщение бота:', result.message)
        setMessages(prev => [...prev, botMessage])
        
        // Проверяем, завершена ли заявка
        if (result.completed) {
          console.log('✅ Заявка завершена!')
          setIsCompleted(true)
        }
      } catch (error) {
        console.error('❌ Ошибка отправки сообщения:', error)
        const errorMessage = {
          id: Date.now() + 1,
          text: "Извините, произошла ошибка. Попробуйте еще раз.",
          sender: 'bot',
          timestamp: new Date()
        }
        setMessages(prev => [...prev, errorMessage])
      } finally {
        setIsLoading(false)
      }
    } else {
      // Если не в режиме сбора данных, просто очищаем поле
      console.log('🧹 Очищаем поле ввода (не в режиме сбора данных)')
      setInputMessage('')
      setSelectedFile(null)
    }
  }

  const handleShowTerms = () => {
    setShowPrivacyModal(true)
  }

  const handleAcceptTerms = () => {
    console.log('✅ Пользователь принял условия')
    setShowPrivacyModal(false)
    setDialogState('terms_accepted')
    
    const botMessage = {
      id: Date.now(),
      text: "Какую сумму вы хотите получить?",
      sender: 'bot',
      timestamp: new Date()
    }
    
    setMessages(prev => [...prev, botMessage])
    console.log('🔄 Состояние изменено на: terms_accepted')
  }

  const handleDeclineTerms = () => {
    setShowPrivacyModal(false)
    
    const botMessage = {
      id: Date.now(),
      text: "Для продолжения необходимо принять условия платформы. Если у вас есть вопросы, обратитесь к нам по email info@ikapitalist.kz",
      sender: 'bot',
      timestamp: new Date()
    }
    
    setMessages(prev => [...prev, botMessage])
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  const handleShowReport = async () => {
    if (!sessionId) {
      alert('Сессия не найдена')
      return
    }
    
    setLoadingReport(true)
    setShowReportModal(true)
    
    try {
      const resp = await fetch(`/api/agents/report/${sessionId}`)
      const result = await resp.json()
      
      if (result.ok) {
        setReportData(result)
      } else {
        setReportData({ error: result.message })
        // Повторная попытка через 3 секунды
        setTimeout(() => handleShowReport(), 3000)
      }
    } catch (error) {
      console.error('❌ Ошибка загрузки отчета:', error)
      setReportData({ error: 'Ошибка загрузки отчета' })
    } finally {
      setLoadingReport(false)
    }
  }

  return (
    <div className="agents-chat-container">
      <PrivacyPolicyModal 
        isOpen={showPrivacyModal}
        onClose={handleDeclineTerms}
        onAccept={handleAcceptTerms}
      />
      
      <div className="agents-chat-header">
        <div className="agents-chat-title">
          <Bot size={24} />
          <span>AI Помощник по инвестициям (Agents SDK)</span>
        </div>
      </div>

      <div className="agents-chat-messages">
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.sender}`}>
            <div className="message-avatar">
              {message.sender === 'bot' ? <Bot size={20} /> : <User size={20} />}
            </div>
            <div className="message-content">
              <div className="message-text">{message.text}</div>
              {message.showTermsButton && (
                <div className="message-actions">
                  <button 
                    onClick={handleShowTerms}
                    className="terms-button"
                  >
                    Принять условия платформы
                  </button>
                </div>
              )}
              {message.data && (
                <div className="message-data">
                  <pre>{JSON.stringify(message.data, null, 2)}</pre>
                </div>
              )}
              <div className="message-time">
                {message.timestamp.toLocaleTimeString('ru-RU', { 
                  hour: '2-digit', 
                  minute: '2-digit' 
                })}
              </div>
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="message bot">
            <div className="message-avatar">
              <Bot size={20} />
            </div>
            <div className="message-content">
              <div className="message-text">
                <Loader size={16} className="animate-spin" />
                Обрабатываю запрос...
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      <div className="agents-chat-input">
        {isCompleted ? (
          <div className="completion-message">
            <div className="completion-text">
              Заявка завершена. Спасибо за предоставленную информацию!
            </div>
            <button 
              onClick={handleShowReport}
              className="report-button"
            >
              📊 Отчет для менеджера
            </button>
          </div>
        ) : (
          <div className="input-container">
            {selectedFile && (
              <div className="selected-file">
                <span>📎 {selectedFile.name}</span>
                <button 
                  onClick={() => setSelectedFile(null)}
                  className="remove-file"
                >
                  ×
                </button>
              </div>
            )}
            <textarea
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Напишите сообщение..."
              className="message-input"
              rows="1"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="attach-button"
              title="Прикрепить файл"
            >
              <Paperclip size={20} />
            </button>
            <button
              onClick={handleSendMessage}
              disabled={(!inputMessage.trim() && !selectedFile) || isLoading}
              className="send-button"
            >
              <Send size={20} />
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileSelect}
          accept=".pdf,.xlsx,.xls,.csv,.doc,.docx"
          style={{ display: 'none' }}
        />
      </div>
      
      {/* Модальное окно с отчетом */}
      {showReportModal && (
        <div className="report-modal-overlay" onClick={() => setShowReportModal(false)}>
          <div className="report-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="report-modal-header">
              <h2>📊 Финансовый отчет для менеджера</h2>
              <button 
                onClick={() => setShowReportModal(false)}
                className="report-modal-close"
              >
                ×
              </button>
            </div>
            <div className="report-modal-body">
              {loadingReport ? (
                <div className="report-loading">
                  <Loader size={32} className="animate-spin" />
                  <p>Загрузка отчета...</p>
                </div>
              ) : reportData?.error ? (
                <div className="report-error">
                  <p>{reportData.error}</p>
                  <p style={{ fontSize: '14px', color: '#666' }}>
                    Отчет генерируется автоматически после завершения заявки. 
                    Пожалуйста, подождите еще несколько секунд...
                  </p>
                </div>
              ) : reportData?.report ? (
                <div className="report-text">
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                    {reportData.report}
                  </pre>
                  <div className="report-meta">
                    <small>Сгенерировано: {new Date(reportData.generated).toLocaleString('ru-RU')}</small>
                    <small>Файлов проанализировано: {reportData.filesCount}</small>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AgentsChat
