import React, { useState, useRef, useEffect } from 'react'
import { Send, User, Paperclip } from 'lucide-react'
import PrivacyPolicyModal from './PrivacyPolicyModal'
import { getApiUrl } from '../utils/api'
import './AgentsChat.css'

// Иконка с буквами "iK" для iKapitalist
const AIIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" fill="url(#ikGradient)" />
    <text 
      x="12" 
      y="16" 
      fontFamily="system-ui, -apple-system, sans-serif" 
      fontSize="11" 
      fontWeight="700" 
      fill="white" 
      textAnchor="middle"
    >
      iK
    </text>
    <defs>
      <linearGradient id="ikGradient" x1="2" y1="2" x2="22" y2="22">
        <stop stopColor="#667eea" />
        <stop offset="1" stopColor="#764ba2" />
      </linearGradient>
    </defs>
  </svg>
)

const AgentsChat = () => {
  const [messages, setMessages] = useState([
    {
      id: 1,
      text: "Здравствуйте, как я могу к Вам обращаться?",
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
  const fileInputRef = useRef(null)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }


  // Функция для создания сообщения бота
  const createBotMessage = (text, options = {}) => ({
    id: Date.now() + (options.idOffset || 1),
    text,
    sender: 'bot',
    timestamp: new Date(),
    ...options
  })

  // Функция для создания сообщения пользователя  
  const createUserMessage = (text, file = null) => ({
    id: Date.now(),
    text: text + (file ? ` (файл: ${file.name})` : ''),
    sender: 'user',
    timestamp: new Date()
  })

  // Общая функция для отправки сообщений к агенту
  const sendToAgent = async (messageText, selectedFile) => {
    setIsLoading(true)

    try {
      // Подготавливаем FormData для отправки файла
      const formData = new FormData()
      formData.append('text', messageText)
      if (sessionId) formData.append('sessionId', sessionId)
      if (selectedFile) formData.append('file', selectedFile)

      // call backend server
      const resp = await fetch(getApiUrl('/api/agents/run'), {
        method: 'POST',
        body: formData
      })
      
      const result = await resp.json()
      
      // Сохраняем sessionId для следующих запросов
      if (result.sessionId && !sessionId) {
        setSessionId(result.sessionId)
        localStorage.setItem('ikap_sessionId', result.sessionId)
      }
      
      // Проверяем, был ли запрос успешным
      if (result.ok === false) {
        console.error('⚠️ Сервер вернул ошибку:', result.message)
        const errorMessage = createBotMessage(
          result.message || "Произошла ошибка. Попробуйте еще раз."
        )
        setMessages(prev => [...prev, errorMessage])
        return false // Возвращаем false для индикации ошибки
      }
      
      const botMessage = createBotMessage(result.message, { data: result.data })
      setMessages(prev => [...prev, botMessage])
      
      // Проверяем, завершена ли заявка  
      if (result.completed) {
        setIsCompleted(true)
        // Очищаем sessionId после завершения заявки
        localStorage.removeItem('ikap_sessionId')
      }
      
      return true // Возвращаем true для индикации успеха
    } catch (error) {
      console.error('❌ Ошибка отправки сообщения:', error)
      const errorMessage = createBotMessage("Извините, произошла ошибка. Попробуйте еще раз.")
      setMessages(prev => [...prev, errorMessage])
      return false
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])
  
  // Инициализация sessionId из localStorage при первой загрузке
  useEffect(() => {
    const savedSessionId = localStorage.getItem('ikap_sessionId')
    if (savedSessionId) {
      setSessionId(savedSessionId)
    }
  }, [])

  // Сохранение sessionId в localStorage для продолжения диалога с сервером
  useEffect(() => {
    if (sessionId) {
      localStorage.setItem('ikap_sessionId', sessionId)
    }
  }, [sessionId])
  

  const handleFileSelect = (event) => {
    const file = event.target.files[0]
    if (file) {
      setSelectedFile(file)
      setInputMessage(`Прикрепляю файл: ${file.name}`)
    }
  }

  const handleSendMessage = async () => {
    if ((!inputMessage.trim() && !selectedFile) || isLoading) return


    const userMessage = createUserMessage(inputMessage, selectedFile)

    setMessages(prev => [...prev, userMessage])
    
    const messageText = inputMessage.trim()
    
    // Обработка состояний диалога
    if (dialogState === 'greeting') {
      setUserName(messageText)
      setDialogState('name_collected')
      
      // Показываем спинер на 3 секунды
      setInputMessage('')
      setSelectedFile(null)
      setIsLoading(true)
      
      setTimeout(() => {
        const botMessage = createBotMessage(
          `Здравствуйте, ${messageText}! Наша платформа помогает бизнесу привлекать финансирование от 10 млн до 1 млрд ₸ под 2,5% годовых. Срок займа — 4–36 месяцев. Быстрое одобрение, прозрачные условия, инвесторы, готовые поддержать ваш проект. Примите условия платформы и подготовьте актуальные банковские выписки за последние 12 месяцев.`,
          { showTermsButton: true }
        )
        
        setMessages(prev => [...prev, botMessage])
        setIsLoading(false)
      }, 3000)
      
      return
    }
    
    if (dialogState === 'name_collected') {
      // Пользователь не должен отвечать здесь - модальное окно должно быть открыто
      return
    }
    
    if (dialogState === 'terms_accepted') {
      setDialogState('data_collection')
      
      // Сразу отправляем в агента после изменения состояния
      await sendToAgent(messageText, selectedFile)
      
      // Очищаем поля после отправки
      setInputMessage('')
      setSelectedFile(null)
      return
    }
    
    // Если мы в режиме сбора данных, отправляем в агента
    if (dialogState === 'data_collection') {
      await sendToAgent(messageText, selectedFile)
      
      // Очищаем поля после отправки
      setInputMessage('')
      setSelectedFile(null)
    } else {
      // Если не в режиме сбора данных, просто очищаем поле
      setInputMessage('')
      setSelectedFile(null)
    }
  }

  const handleShowTerms = () => {
    setShowPrivacyModal(true)
  }

  const handleAcceptTerms = () => {
    setShowPrivacyModal(false)
    setDialogState('terms_accepted')
    
    // Показываем спиннер на 3 секунды
    setIsLoading(true)
    
    setTimeout(() => {
      const botMessage = createBotMessage("Какую сумму в тенге Вы хотите получить?")
      setMessages(prev => [...prev, botMessage])
      setIsLoading(false)
    }, 3000)
  }

  const handleDeclineTerms = () => {
    setShowPrivacyModal(false)
    
    const botMessage = createBotMessage(
      "Для продолжения необходимо принять условия платформы. Если у вас есть вопросы, обратитесь к нам по email info@ikapitalist.kz"
    )
    setMessages(prev => [...prev, botMessage])
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
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
          <AIIcon size={28} />
          <span>iKapitalist AI</span>
        </div>
      </div>

      <div className="agents-chat-messages">
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.sender}`}>
            <div className="message-avatar">
              {message.sender === 'bot' ? <AIIcon size={22} /> : <User size={20} />}
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
              <AIIcon size={22} />
            </div>
            <div className="message-content">
              <div className="message-text">
                <div className="loading-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
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
              ✅ Заявка завершена. Спасибо за предоставленную информацию! Мы анализируем ваши документы и свяжемся с вами в ближайшее время.
            </div>
            <button 
              onClick={() => window.location.reload()}
              className="new-application-button"
              style={{
                marginTop: '15px',
                padding: '12px 24px',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '12px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '600',
                boxShadow: '0 4px 15px rgba(102, 126, 234, 0.3)',
                transition: 'all 0.3s ease'
              }}
            >
              Подать новую заявку
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
    </div>
  )
}

export default AgentsChat
