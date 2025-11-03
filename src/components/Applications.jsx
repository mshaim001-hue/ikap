import React, { useState, useEffect, useRef } from 'react'
import { 
  Calendar, 
  User, 
  Building, 
  Phone, 
  Mail, 
  FileText, 
  DollarSign,
  Clock,
  CheckCircle,
  AlertCircle,
  XCircle,
  Trash2,
  MessageSquare,
  Download,
  Paperclip
} from 'lucide-react'
import { getApiUrl } from '../utils/api'
import './Applications.css'

const Applications = () => {
  const [applications, setApplications] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedApplication, setSelectedApplication] = useState(null)
  const [showDialog, setShowDialog] = useState(false)
  const [dialogMessages, setDialogMessages] = useState([])
  const [dialogLoading, setDialogLoading] = useState(false)
  const [files, setFiles] = useState([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [showReportModal, setShowReportModal] = useState(false)
  const pollingIntervalRef = useRef(null)
  const dialogEndRef = useRef(null)

  // Загружаем список заявок
  useEffect(() => {
    fetchApplications()
  }, [])

  const fetchApplications = async () => {
    try {
      setLoading(true)
      const response = await fetch(getApiUrl('/api/reports'))
      const data = await response.json()
      
      if (data.ok) {
        setApplications(data.reports)
      } else {
        console.error('Ошибка загрузки заявок:', data.message)
      }
    } catch (error) {
      console.error('Ошибка загрузки заявок:', error)
    } finally {
      setLoading(false)
    }
  }

  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed':
        return <CheckCircle size={16} className="status-icon completed" />
      case 'generating':
        return <Clock size={16} className="status-icon generating" />
      case 'error':
        return <XCircle size={16} className="status-icon error" />
      default:
        return <AlertCircle size={16} className="status-icon pending" />
    }
  }

  const getStatusText = (status) => {
    switch (status) {
      case 'completed':
        return 'Завершена'
      case 'generating':
        return 'Генерируется отчет'
      case 'error':
        return 'Ошибка'
      default:
        return 'В обработке'
    }
  }

  const formatDate = (dateString) => {
    if (!dateString) return 'Не указано'
    const date = new Date(dateString)
    return date.toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
  }

  const stopPollingReport = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
  }

  const refreshApplication = async (sessionId) => {
    try {
      const response = await fetch(getApiUrl(`/api/reports/${sessionId}`))
      const data = await response.json()
      
      if (data.ok && data.report) {
        setSelectedApplication(data.report)
        
        // Если статус изменился на completed, останавливаем polling
        if (data.report.status === 'completed') {
          stopPollingReport()
        }
      }
    } catch (error) {
      console.error('Ошибка загрузки отчета:', error)
    }
  }

  const startPollingReport = (sessionId) => {
    stopPollingReport() // Останавливаем предыдущий polling если есть
    
    pollingIntervalRef.current = setInterval(async () => {
      await refreshApplication(sessionId)
    }, 3000) // Обновляем каждые 3 секунды
  }

  const loadFiles = async (sessionId) => {
    try {
      setFilesLoading(true)
      const response = await fetch(getApiUrl(`/api/sessions/${sessionId}/files`))
      const data = await response.json()
      
      if (data.ok && data.files) {
        setFiles(data.files)
      }
    } catch (error) {
      console.error('Ошибка загрузки файлов:', error)
    } finally {
      setFilesLoading(false)
    }
  }

  const loadDialog = async (sessionId) => {
    try {
      setDialogLoading(true)
      const response = await fetch(getApiUrl(`/api/sessions/${sessionId}/history`))
      const data = await response.json()
      
      if (data.ok && data.messages) {
        setDialogMessages(data.messages)
        setShowDialog(true)
        // Прокручиваем вниз после загрузки
        setTimeout(() => {
          dialogEndRef.current?.scrollIntoView({ behavior: 'smooth' })
        }, 100)
      } else {
        console.error('Ошибка загрузки диалога:', data.message)
        setDialogMessages([])
      }
    } catch (error) {
      console.error('Ошибка загрузки диалога:', error)
      setDialogMessages([])
    } finally {
      setDialogLoading(false)
    }
  }

  const handleDownloadFile = async (fileId, fileName) => {
    try {
      const response = await fetch(getApiUrl(`/api/files/${fileId}/download`))
      if (!response.ok) {
        throw new Error('Ошибка скачивания файла')
      }
      
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      console.error('Ошибка скачивания файла:', error)
      alert('Не удалось скачать файл')
    }
  }

  const handleApplicationClick = async (application) => {
    console.log('🔍 Выбрана заявка:', application)
    console.log('📊 Статус:', application.status)
    console.log('📄 Отчет:', application.reportText ? 'Есть' : 'Нет')
    
    setSelectedApplication(application)
    setShowDialog(false)
    setDialogMessages([])
    setFiles([])
    
    // Загружаем файлы для этой заявки
    loadFiles(application.sessionId)
    
    // Если отчет еще генерируется, запускаем polling
    if (application.status === 'generating') {
      startPollingReport(application.sessionId)
    } else {
      stopPollingReport()
    }
    
    // Загружаем актуальные данные заявки
    await refreshApplication(application.sessionId)
  }

  useEffect(() => {
    return () => {
      stopPollingReport()
    }
  }, [])

  const handleDeleteApplication = async (applicationId, event) => {
    event.stopPropagation() // Предотвращаем открытие деталей заявки
    
    if (window.confirm('Вы уверены, что хотите удалить эту заявку?')) {
      try {
        const response = await fetch(getApiUrl(`/api/reports/${applicationId}`), {
          method: 'DELETE'
        })
        
        if (response.ok) {
          // Удаляем заявку из списка
          setApplications(prev => prev.filter(app => app.sessionId !== applicationId))
          
          // Если удаляемая заявка была выбрана, очищаем выбор
          if (selectedApplication?.sessionId === applicationId) {
            setSelectedApplication(null)
          }
          
          console.log('Заявка удалена успешно')
        } else {
          console.error('Ошибка удаления заявки')
        }
      } catch (error) {
        console.error('Ошибка удаления заявки:', error)
      }
    }
  }

  if (loading) {
    return (
      <div className="applications-container">
        <div className="applications-header">
          <h2>Заявки</h2>
        </div>
        <div className="loading">
          <Clock size={24} className="animate-spin" />
          <span>Загрузка заявок...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="applications-container">
      <div className="applications-header">
        <h2>Заявки ({applications.length})</h2>
        <button 
          onClick={fetchApplications}
          className="refresh-button"
        >
          Обновить
        </button>
      </div>

      <div className="applications-content">
        <div className="applications-list">
          {applications.length === 0 ? (
            <div className="empty-state">
              <FileText size={48} />
              <h3>Заявок пока нет</h3>
              <p>Новые заявки будут отображаться здесь</p>
            </div>
          ) : (
            applications.map((app) => (
              <div 
                key={app.sessionId}
                className={`application-card ${selectedApplication?.sessionId === app.sessionId ? 'selected' : ''}`}
                onClick={() => handleApplicationClick(app)}
              >
                <div className="application-header">
                  <div className="application-status">
                    {getStatusIcon(app.status)}
                    <span className="status-text">{getStatusText(app.status)}</span>
                  </div>
                  <div className="application-date">
                    {formatDate(app.createdAt)}
                  </div>
                </div>

                <div className="application-info">
                  <div className="info-row">
                    <Building size={16} />
                    <span className="label">Компания:</span>
                    <span className="value">{app.bin || 'Не указан'}</span>
                  </div>
                  
                  <div className="info-row">
                    <User size={16} />
                    <span className="label">Контакт:</span>
                    <span className="value">{app.name || 'Не указано'}</span>
                  </div>
                  
                  <div className="info-row">
                    <DollarSign size={16} />
                    <span className="label">Сумма:</span>
                    <span className="value">{app.amount || 'Не указана'}</span>
                  </div>
                  
                  <div className="info-row">
                    <Clock size={16} />
                    <span className="label">Срок:</span>
                    <span className="value">{app.term || 'Не указан'}</span>
                  </div>
                  
                  {app.email && (
                    <div className="info-row">
                      <Mail size={16} />
                      <span className="label">Email:</span>
                      <span className="value">{app.email}</span>
                    </div>
                  )}
                  
                  {app.phone && (
                    <div className="info-row">
                      <Phone size={16} />
                      <span className="label">Телефон:</span>
                      <span className="value">{app.phone}</span>
                    </div>
                  )}
                </div>

                <div className="application-footer">
                  <div className="files-count">
                    <FileText size={14} />
                    <span>{app.filesCount || 0} файлов</span>
                  </div>
                  <button 
                    className="delete-button"
                    onClick={(e) => handleDeleteApplication(app.sessionId, e)}
                    title="Удалить заявку"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {selectedApplication && (
          <div className="application-details">
            <div className="details-header">
              <h3>Детали заявки</h3>
              <button 
                onClick={() => {
                  setSelectedApplication(null)
                  setShowDialog(false)
                  stopPollingReport()
                }}
                className="close-button"
              >
                ×
              </button>
            </div>
            
            <div className="details-content">
              <div className="detail-section">
                <div className="detail-actions">
                  <button
                    onClick={() => loadDialog(selectedApplication.sessionId)}
                    className="dialog-button"
                  >
                    <MessageSquare size={16} />
                    Диалог
                  </button>
                </div>
              </div>
              <div className="detail-section">
                <h4>Основная информация</h4>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">БИН:</span>
                    <span className="detail-value">{selectedApplication.bin || 'Не указан'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Сумма:</span>
                    <span className="detail-value">{selectedApplication.amount || 'Не указана'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Срок:</span>
                    <span className="detail-value">{selectedApplication.term || 'Не указан'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Цель:</span>
                    <span className="detail-value">{selectedApplication.purpose || 'Не указана'}</span>
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <h4>Контактные данные</h4>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Имя:</span>
                    <span className="detail-value">{selectedApplication.name || 'Не указано'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Email:</span>
                    <span className="detail-value">{selectedApplication.email || 'Не указан'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Телефон:</span>
                    <span className="detail-value">{selectedApplication.phone || 'Не указан'}</span>
                  </div>
                </div>
              </div>

              {files.length > 0 && (() => {
                // Группируем файлы по категориям
                const statements = files.filter(f => f.category === 'statements' || !f.category)
                const taxes = files.filter(f => f.category === 'taxes')
                const financial = files.filter(f => f.category === 'financial')
                
                return (
                  <div className="detail-section">
                    <h4>Файлы ({files.length})</h4>
                    
                    {/* Выписки */}
                    {statements.length > 0 && (
                      <div className="files-category">
                        <h5 className="files-category-title">Выписки</h5>
                        <div className="files-list">
                          {statements.map((file, index) => (
                            <div key={index} className="file-item">
                              <Paperclip size={14} />
                              <span className="file-name" title={file.originalName}>
                                {file.originalName}
                              </span>
                              <span className="file-size">
                                {formatFileSize(file.fileSize)}
                              </span>
                              <button
                                onClick={() => handleDownloadFile(file.fileId, file.originalName)}
                                className="download-file-button"
                                title="Скачать файл"
                              >
                                <Download size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Налоги */}
                    {taxes.length > 0 && (
                      <div className="files-category">
                        <h5 className="files-category-title">Налоги</h5>
                        <div className="files-list">
                          {taxes.map((file, index) => (
                            <div key={index} className="file-item">
                              <Paperclip size={14} />
                              <span className="file-name" title={file.originalName}>
                                {file.originalName}
                              </span>
                              <span className="file-size">
                                {formatFileSize(file.fileSize)}
                              </span>
                              <button
                                onClick={() => handleDownloadFile(file.fileId, file.originalName)}
                                className="download-file-button"
                                title="Скачать файл"
                              >
                                <Download size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Финансовый отчет */}
                    {financial.length > 0 && (
                      <div className="files-category">
                        <h5 className="files-category-title">Фин отчет</h5>
                        <div className="files-list">
                          {financial.map((file, index) => (
                            <div key={index} className="file-item">
                              <Paperclip size={14} />
                              <span className="file-name" title={file.originalName}>
                                {file.originalName}
                              </span>
                              <span className="file-size">
                                {formatFileSize(file.fileSize)}
                              </span>
                              <button
                                onClick={() => handleDownloadFile(file.fileId, file.originalName)}
                                className="download-file-button"
                                title="Скачать файл"
                              >
                                <Download size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}

              <div className="detail-section">
                <h4>Финансовый отчет</h4>
                {selectedApplication.reportText ? (
                  <>
                    <button
                      onClick={() => setShowReportModal(true)}
                      className="view-report-button"
                    >
                      <FileText size={16} />
                      Просмотреть отчет
                    </button>
                    <div className="report-preview">
                      <p style={{ color: '#6b7280', fontSize: '12px' }}>
                        Отчет готов. Нажмите кнопку выше для просмотра.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="report-content">
                    <p style={{ color: '#6b7280', fontStyle: 'italic' }}>
                      {selectedApplication.status === 'generating' 
                        ? 'Отчет генерируется...' 
                        : 'Финансовый отчет не готов'
                      }
                    </p>
                  </div>
                )}
              </div>

              {/* Модальное окно для просмотра отчета */}
              {showReportModal && selectedApplication.reportText && (
                <div className="report-modal-overlay" onClick={() => setShowReportModal(false)}>
                  <div className="report-modal-content" onClick={(e) => e.stopPropagation()}>
                    <div className="report-modal-header">
                      <h3>Финансовый отчет</h3>
                      <button
                        onClick={() => setShowReportModal(false)}
                        className="report-modal-close"
                      >
                        ×
                      </button>
                    </div>
                    <div className="report-modal-body">
                      <pre className="report-text">{selectedApplication.reportText}</pre>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {showDialog && (
              <div className="dialog-panel">
                <div className="dialog-header">
                  <h4>Диалог с пользователем</h4>
                  <button
                    onClick={() => setShowDialog(false)}
                    className="close-dialog-button"
                  >
                    ×
                  </button>
                </div>
                <div className="dialog-messages">
                  {dialogLoading ? (
                    <div className="dialog-loading">
                      <Clock size={20} className="animate-spin" />
                      <span>Загрузка диалога...</span>
                    </div>
                  ) : dialogMessages.length > 0 ? (
                    dialogMessages.map((msg) => (
                      <div key={msg.id} className={`dialog-message ${msg.sender === 'user' ? 'user-message' : 'bot-message'}`}>
                        <div className="message-sender">
                          {msg.sender === 'user' ? '👤 Пользователь' : '🤖 Бот'}
                        </div>
                        <div className="message-text">{msg.text}</div>
                        <div className="message-time">
                          {new Date(msg.timestamp).toLocaleString('ru-RU')}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="dialog-empty">
                      <p>Диалог не найден</p>
                    </div>
                  )}
                  <div ref={dialogEndRef} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default Applications
