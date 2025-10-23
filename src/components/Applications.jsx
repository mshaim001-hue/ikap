import React, { useState, useEffect } from 'react'
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
  Trash2
} from 'lucide-react'
import { getApiUrl } from '../utils/api'
import './Applications.css'

const Applications = () => {
  const [applications, setApplications] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedApplication, setSelectedApplication] = useState(null)

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

  const handleApplicationClick = async (application) => {
    console.log('🔍 Выбрана заявка:', application)
    console.log('📊 Статус:', application.status)
    console.log('📄 Отчет:', application.reportText ? 'Есть' : 'Нет')
    
    setSelectedApplication(application)
    
    // Если отчет еще генерируется, загружаем его
    if (application.status === 'generating') {
      try {
        const response = await fetch(getApiUrl(`/api/reports/${application.sessionId}`))
        const data = await response.json()
        
        if (data.ok && data.report) {
          console.log('📊 Загружен отчет:', data.report.reportText ? 'Есть' : 'Нет')
          setSelectedApplication(data.report)
        }
      } catch (error) {
        console.error('Ошибка загрузки отчета:', error)
      }
    }
  }

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
                onClick={() => setSelectedApplication(null)}
                className="close-button"
              >
                ×
              </button>
            </div>
            
            <div className="details-content">
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

              {selectedApplication.reportText ? (
                <div className="detail-section">
                  <h4>Финансовый отчет</h4>
                  <div className="report-content">
                    <pre>{selectedApplication.reportText}</pre>
                  </div>
                </div>
              ) : (
                <div className="detail-section">
                  <h4>Финансовый отчет</h4>
                  <div className="report-content">
                    <p style={{ color: '#6b7280', fontStyle: 'italic' }}>
                      {selectedApplication.status === 'generating' 
                        ? 'Отчет генерируется...' 
                        : 'Финансовый отчет не готов'
                      }
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Applications
