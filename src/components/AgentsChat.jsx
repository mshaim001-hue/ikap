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
  const [isRestoringSession, setIsRestoringSession] = useState(false)
  const fileInputRef = useRef(null)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])
  
  // Сохранение состояния в localStorage
  useEffect(() => {
    if (sessionId) {
      localStorage.setItem('ikap_sessionId', sessionId)
    }
    if (dialogState) {
      localStorage.setItem('ikap_dialogState', dialogState)
    }
    if (userName) {
      localStorage.setItem('ikap_userName', userName)
    }
    if (isCompleted) {
      localStorage.setItem('ikap_isCompleted', 'true')
    }
  }, [sessionId, dialogState, userName, isCompleted])
  
  // Восстановление сессии при загрузке компонента
  useEffect(() => {
    const restoreSession = async () => {
      const savedSessionId = localStorage.getItem('ikap_sessionId')
      const savedDialogState = localStorage.getItem('ikap_dialogState')
      const savedUserName = localStorage.getItem('ikap_userName')
      const savedIsCompleted = localStorage.getItem('ikap_isCompleted')
      
      console.log('🔄 Проверка сохраненного состояния:', {
        sessionId: savedSessionId,
        dialogState: savedDialogState,
        userName: savedUserName
      })
      
      // Если есть сохраненное состояние диалога (даже без sessionId)
      if (savedDialogState && savedDialogState !== 'greeting') {
        console.log('🔄 Восстанавливаем состояние диалога:', savedDialogState)
        
        // Восстанавливаем локальное состояние
        if (savedUserName) {
          setUserName(savedUserName)
          console.log('👤 Имя восстановлено:', savedUserName)
        }
        
        if (savedIsCompleted === 'true') {
          setIsCompleted(true)
        }
        
        // Если есть sessionId, пытаемся восстановить историю с сервера
        if (savedSessionId) {
          setIsRestoringSession(true)
          
          try {
            console.log('📡 Запрос истории сессии:', savedSessionId)
            const response = await fetch(getApiUrl(`/api/sessions/${savedSessionId}/history`))
            
            if (response.ok) {
              const data = await response.json()
              console.log('✅ История сессии получена:', data)
              
              if (data.messages && data.messages.length > 0) {
                // Восстанавливаем полную сессию
                setSessionId(savedSessionId)
                setMessages(data.messages)
                setDialogState(savedDialogState)
                
                console.log('✅ Полная сессия восстановлена!')
              } else {
                // Если история пуста на сервере, восстанавливаем только локальное состояние
                console.log('⚠️ История на сервере пуста, восстанавливаем локальное состояние')
                setDialogState(savedDialogState)
                
                // Восстанавливаем приветственное сообщение в зависимости от состояния
                if (savedDialogState === 'name_collected' && savedUserName) {
                  setMessages([
                    {
                      id: 1,
                      text: "Здравствуйте, как я могу к Вам обращаться?",
                      sender: 'bot',
                      timestamp: new Date()
                    },
                    {
                      id: 2,
                      text: savedUserName,
                      sender: 'user',
                      timestamp: new Date()
                    },
                    {
                      id: 3,
                      text: `Приятно познакомиться, ${savedUserName}! Для продолжения работы с платформой iKapitalist необходимо ознакомиться с условиями использования и политикой конфиденциальности.`,
                      sender: 'bot',
                      timestamp: new Date(),
                      showTermsButton: true
                    }
                  ])
                } else if (savedDialogState === 'terms_accepted') {
                  setMessages([
                    {
                      id: 1,
                      text: "Здравствуйте, как я могу к Вам обращаться?",
                      sender: 'bot',
                      timestamp: new Date()
                    },
                    {
                      id: 2,
                      text: savedUserName || 'Пользователь',
                      sender: 'user',
                      timestamp: new Date()
                    },
                    {
                      id: 3,
                      text: `Приятно познакомиться, ${savedUserName}! Для продолжения работы с платформой iKapitalist необходимо ознакомиться с условиями использования и политикой конфиденциальности.`,
                      sender: 'bot',
                      timestamp: new Date()
                    },
                    {
                      id: 4,
                      text: 'Условия приняты',
                      sender: 'user',
                      timestamp: new Date()
                    },
                    {
                      id: 5,
                      text: 'Спасибо! Теперь вы можете начать работу с платформой. Чем я могу вам помочь?',
                      sender: 'bot',
                      timestamp: new Date()
                    }
                  ])
                }
              }
            } else {
              // Если сессия не найдена на сервере, восстанавливаем локальное состояние
              console.log('⚠️ Сессия не найдена на сервере, восстанавливаем локальное состояние')
              setDialogState(savedDialogState)
            }
          } catch (error) {
            console.error('❌ Ошибка восстановления сессии:', error)
            // В случае ошибки все равно восстанавливаем локальное состояние
            setDialogState(savedDialogState)
          }
          
          setIsRestoringSession(false)
        } else {
          // Если нет sessionId, просто восстанавливаем состояние диалога
          setDialogState(savedDialogState)
          console.log('✅ Локальное состояние восстановлено (без sessionId)')
        }
      }
    }
    
    restoreSession()
  }, [])

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
      
      // Показываем спинер на 3 секунды
      setInputMessage('')
      setSelectedFile(null)
      setIsLoading(true)
      
      setTimeout(() => {
        const botMessage = {
          id: Date.now() + 1,
          text: `Здравствуйте, ${messageText}. Вы находитесь на платформе по привлечению денег для вашего бизнеса. 
Получите финансирование от 10 млн до 1 млрд тенге под 2,5% годовых через нашу краудфандинговую платформу.
Срок займа — от 4 до 36 месяцев.
Быстрое одобрение, прозрачные условия, доступ к сообществу инвесторов, готовых поддержать ваш проект.
Прежде чем продолжить, пожалуйста, примите условия платформы и подготовьте выписки с банка юр лица за этот год и предыдущий`,
          sender: 'bot',
          timestamp: new Date(),
          showTermsButton: true
        }
        
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
        const resp = await fetch(getApiUrl('/api/agents/run'), {
          method: 'POST',
          body: formData
        })
        
        console.log('📥 Получен ответ от сервера:', resp.status)
        const result = await resp.json()
        console.log('📋 Результат:', result)
        
        // Сохраняем sessionId для следующих запросов
        if (result.sessionId && !sessionId) {
          setSessionId(result.sessionId)
          localStorage.setItem('ikap_sessionId', result.sessionId)
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
      
      setIsLoading(true)

      try {
        // Подготавливаем FormData для отправки файла
        const formData = new FormData()
        formData.append('text', messageText)
        if (sessionId) formData.append('sessionId', sessionId)
        if (selectedFile) formData.append('file', selectedFile)

        console.log('📤 Отправляем запрос к серверу...')
        
        // call backend server
        const resp = await fetch(getApiUrl('/api/agents/run'), {
          method: 'POST',
          body: formData
        })
        
        console.log('📥 Получен ответ от сервера:', resp.status)
        const result = await resp.json()
        console.log('📋 Результат:', result)
        
        // Сохраняем sessionId для следующих запросов
        if (result.sessionId && !sessionId) {
          setSessionId(result.sessionId)
          localStorage.setItem('ikap_sessionId', result.sessionId)
          console.log('🆔 Новый sessionId:', result.sessionId)
        }
        
        // Проверяем, был ли запрос успешным
        if (result.ok === false) {
          console.error('⚠️ Сервер вернул ошибку:', result.message)
          const errorMessage = {
            id: Date.now() + 1,
            text: result.message || "Произошла ошибка. Попробуйте еще раз.",
            sender: 'bot',
            timestamp: new Date()
          }
          setMessages(prev => [...prev, errorMessage])
          // Очищаем поля только после неуспешного ответа
          setInputMessage('')
          setSelectedFile(null)
          return // Выходим, не обрабатываем дальше
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
        
        // Очищаем поля после успешной отправки
        setInputMessage('')
        setSelectedFile(null)
        
        // Проверяем, завершена ли заявка  
        if (result.completed) {
          console.log('✅ Заявка завершена! Отчет генерируется в фоне.')
          setIsCompleted(true)
          // Очищаем localStorage после завершения заявки
          // Пользователь больше не сможет продолжить эту сессию
          localStorage.removeItem('ikap_sessionId')
          localStorage.removeItem('ikap_dialogState')
          localStorage.removeItem('ikap_userName')
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
        // Очищаем поля после ошибки
        setInputMessage('')
        setSelectedFile(null)
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
    
    // Показываем спиннер на 3 секунды
    setIsLoading(true)
    
    setTimeout(() => {
      const botMessage = {
        id: Date.now(),
        text: "Какую сумму в тенге Вы хотите получить?",
        sender: 'bot',
        timestamp: new Date()
      }
      
      setMessages(prev => [...prev, botMessage])
      setIsLoading(false)
      console.log('🔄 Состояние изменено на: terms_accepted')
    }, 3000)
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
        {isRestoringSession ? (
          <div className="message bot">
            <div className="message-avatar">
              <AIIcon size={22} />
            </div>
            <div className="message-content">
              <div className="message-text">Восстанавливаем вашу сессию...</div>
            </div>
          </div>
        ) : null}
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
