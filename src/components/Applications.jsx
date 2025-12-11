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
  const [showStatementsModal, setShowStatementsModal] = useState(false)
  const [showTaxModal, setShowTaxModal] = useState(false)
  const [showFsModal, setShowFsModal] = useState(false)
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

  const refreshApplication = async (sessionId) => {
    try {
      const response = await fetch(getApiUrl(`/api/reports/${sessionId}`))
      const data = await response.json()
      
      if (data.ok && data.report) {
        setSelectedApplication(data.report)
        // Также обновляем заявку в списке
        setApplications(prev => prev.map(app => 
          app.sessionId === sessionId ? data.report : app
        ))
      }
    } catch (error) {
      console.error('Ошибка загрузки отчета:', error)
    }
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
    
    // Загружаем актуальные данные заявки один раз
    await refreshApplication(application.sessionId)
  }

  useEffect(() => {
    return () => {
      // Cleanup если нужно
    }
  }, [])

  // Автоматическое обновление статуса заявки, если она генерируется
  useEffect(() => {
    if (!selectedApplication) return

    // Если заявка завершена или не генерируется, не обновляем
    const isGenerating = selectedApplication.status === 'generating' || 
                        selectedApplication.taxStatus === 'generating' || 
                        selectedApplication.fsStatus === 'generating'
    
    if (!isGenerating) return

    // Обновляем статус каждые 5 секунд
    const interval = setInterval(async () => {
      if (selectedApplication?.sessionId) {
        await refreshApplication(selectedApplication.sessionId)
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [selectedApplication])

  const handleDeleteApplication = async (applicationId, event) => {
    event.stopPropagation() // Предотвращаем открытие деталей заявки
    
    if (window.confirm('Вы уверены, что хотите удалить эту заявку? Все данные (сообщения, файлы) будут удалены безвозвратно.')) {
      try {
        const response = await fetch(getApiUrl(`/api/reports/${applicationId}`), {
          method: 'DELETE'
        })
        
        if (response.ok) {
          const data = await response.json()
          
          if (data.ok) {
            // Удаляем заявку из списка
            setApplications(prev => prev.filter(app => app.sessionId !== applicationId))
            
            // Если удаляемая заявка была выбрана, очищаем выбор
            if (selectedApplication?.sessionId === applicationId) {
              setSelectedApplication(null)
              setShowDialog(false)
              setDialogMessages([])
              setFiles([])
            }
            
            console.log('✅ Заявка удалена успешно')
          } else {
            console.error('❌ Ошибка удаления заявки:', data.message)
            alert(`Не удалось удалить заявку: ${data.message || 'Неизвестная ошибка'}`)
          }
        } else {
          let errorMessage = 'Не удалось удалить заявку'
          try {
            const errorData = await response.json()
            errorMessage = errorData.message || errorMessage
          } catch (e) {
            // Игнорируем ошибку парсинга
          }
          console.error('❌ Ошибка удаления заявки:', response.status, errorMessage)
          alert(errorMessage)
        }
      } catch (error) {
        console.error('❌ Ошибка удаления заявки:', error)
        alert('Не удалось удалить заявку. Проверьте соединение с сервером.')
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
              <h4>Анализы по документам</h4>
              <div className="detail-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {/* Аналитика выписок */}
                {(() => {
                  const isGenerating = selectedApplication.status === 'generating'
                  const isCompleted = selectedApplication.status === 'completed' && !!selectedApplication.reportText
                  const enabled = isCompleted
                  return (
                    <button
                      onClick={() => enabled && setShowStatementsModal(true)}
                      className={`analysis-button ${enabled ? 'enabled' : 'disabled'}`}
                      disabled={!enabled}
                      title={
                        isGenerating 
                          ? 'Аналитика выписок генерируется...' 
                          : enabled 
                            ? 'Открыть аналитику выписок' 
                            : 'Аналитика выписок еще не готова'
                      }
                    >
                      <FileText size={16} /> 
                      {isGenerating ? 'Аналитика выписок (генерируется...)' : 'Аналитика выписок'}
                    </button>
                  )
                })()}

                {/* Налоговая отчетность */}
                {(() => {
                  const taxStatus = selectedApplication.taxStatus
                  const taxReportText = selectedApplication.taxReportText
                  const isGenerating = taxStatus === 'generating'
                  const hasText = !!taxReportText
                  // Кнопка активна, если анализ завершён УСПЕШНО или с ошибкой, но текст есть
                  const enabled = (taxStatus === 'completed' || taxStatus === 'error') && hasText

                  let title = 'Анализ налоговой отчетности еще не готов'
                  if (isGenerating) {
                    title = 'Анализ налоговой отчетности генерируется...'
                  } else if (enabled && taxStatus === 'completed') {
                    title = 'Открыть анализ налоговой отчетности'
                  } else if (enabled && taxStatus === 'error') {
                    title = 'Открыть сообщение об ошибке анализа налоговой отчетности'
                  }

                  return (
                    <button
                      onClick={() => enabled && setShowTaxModal(true)}
                      className={`analysis-button ${enabled ? 'enabled' : 'disabled'}`}
                      disabled={!enabled}
                      title={title}
                    >
                      <FileText size={16} /> 
                      {isGenerating
                        ? 'Аналитика по налогам (генерируется...)'
                        : 'Аналитика по налогам'}
                    </button>
                  )
                })()}

                {/* Финансовая отчетность */}
                {(() => {
                  const isGenerating = selectedApplication.fsStatus === 'generating'
                  const isCompleted = selectedApplication.fsStatus === 'completed' && !!selectedApplication.fsReportText
                  const enabled = isCompleted
                  return (
                    <button
                      onClick={() => enabled && setShowFsModal(true)}
                      className={`analysis-button ${enabled ? 'enabled' : 'disabled'}`}
                      disabled={!enabled}
                      title={
                        isGenerating 
                          ? 'Анализ финансовой отчетности генерируется...' 
                          : enabled 
                            ? 'Открыть анализ финансовой отчетности' 
                            : 'Анализ фин. отчетности еще не готов'
                      }
                    >
                      <FileText size={16} /> 
                      {isGenerating ? 'Аналитика по фин. отчетам (генерируется...)' : 'Аналитика по фин. отчетам'}
                    </button>
                  )
                })()}
              </div>
              {(selectedApplication.taxMissing || selectedApplication.fsMissing) && (
                <div className="report-preview" style={{ marginTop: 8 }}>
                  {selectedApplication.taxMissing && (
                    <p style={{ color: '#b45309', fontSize: '12px' }}>⚠️ По налоговой отчетности отсутствуют данные за: {selectedApplication.taxMissing}.</p>
                  )}
                  {selectedApplication.fsMissing && (
                    <p style={{ color: '#b45309', fontSize: '12px' }}>⚠️ По финансовой отчетности отсутствуют данные за: {selectedApplication.fsMissing}.</p>
                  )}
                  <p style={{ color: '#6b7280', fontSize: '12px' }}>Анализ выполнен по имеющимся данным.</p>
                </div>
              )}
            </div>

            

              {/* Модальное окно для просмотра отчета */}
              {showStatementsModal && selectedApplication.reportText && (
                <div className="report-modal-overlay" onClick={() => setShowStatementsModal(false)}>
                  <div className="report-modal-content" onClick={(e) => e.stopPropagation()}>
                    <div className="report-modal-header">
                      <h3>Аналитика выписок</h3>
                      <button
                        onClick={() => setShowStatementsModal(false)}
                        className="report-modal-close"
                      >
                        ×
                      </button>
                    </div>
                    <div className="report-modal-body">
                      {(() => {
                        // Парсим объединенный отчет на отдельные отчеты по файлам
                        const reportText = selectedApplication.reportText || ''
                        // Разделяем по паттерну "ОТЧЕТ X из Y\nФайл: имя\n===...\n"
                        const reportSections = reportText.split(/\n\n={80,}\nОТЧЕТ\s+\d+\s+из\s+\d+\nФайл:\s*(.+?)\n={80,}\n\n/)
                        
                        if (reportSections.length > 1) {
                          // Парсим заголовки отдельно
                          const matches = [...reportText.matchAll(/\n\n={80,}\nОТЧЕТ\s+(\d+)\s+из\s+(\d+)\nФайл:\s*(.+?)\n={80,}\n\n/g)]
                          
                          return (
                            <div className="reports-list">
                              {matches.map((match, idx) => {
                                const reportNum = match[1]
                                const totalNum = match[2]
                                const fileName = match[3]
                                const startIndex = match.index + match[0].length
                                const endIndex = idx < matches.length - 1 ? matches[idx + 1].index : reportText.length
                                const reportContent = reportText.substring(startIndex, endIndex).trim()
                                
                                return (
                                  <div key={idx} className="report-file-section">
                                    <div className="report-file-header">
                                      <FileText size={16} />
                                      <h4>Отчет {reportNum} из {totalNum}: {fileName}</h4>
                                    </div>
                                    <pre className="report-text">{reportContent}</pre>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        } else {
                          // Если разделителей нет - показываем как есть
                          return <pre className="report-text">{reportText}</pre>
                        }
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {showTaxModal && (
                <div className="report-modal-overlay" onClick={() => setShowTaxModal(false)}>
                  <div className="report-modal-content" onClick={(e) => e.stopPropagation()}>
                    <div className="report-modal-header">
                      <h3>Анализ налоговой отчетности</h3>
                      <button onClick={() => setShowTaxModal(false)} className="report-modal-close">×</button>
                    </div>
                    <div className="report-modal-body">
                      {(() => {
                        const taxReportText = selectedApplication.taxReportText || ''
                        if (!taxReportText || taxReportText === 'Анализ не готов') {
                          return <pre className="report-text">Анализ не готов</pre>
                        }
                        
                        const matches = [...taxReportText.matchAll(/\n\n={80,}\nОТЧЕТ\s+(\d+)\s+из\s+(\d+)\nФайл:\s*(.+?)\n={80,}\n\n/g)]
                        
                        if (matches.length > 0) {
                          return (
                            <div className="reports-list">
                              {matches.map((match, idx) => {
                                const reportNum = match[1]
                                const totalNum = match[2]
                                const fileName = match[3]
                                const startIndex = match.index + match[0].length
                                const endIndex = idx < matches.length - 1 ? matches[idx + 1].index : taxReportText.length
                                const reportContent = taxReportText.substring(startIndex, endIndex).trim()
                                
                                return (
                                  <div key={idx} className="report-file-section">
                                    <div className="report-file-header">
                                      <FileText size={16} />
                                      <h4>Отчет {reportNum} из {totalNum}: {fileName}</h4>
                                    </div>
                                    <pre className="report-text">{reportContent}</pre>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        } else {
                          return <pre className="report-text">{taxReportText}</pre>
                        }
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {showFsModal && (
                <div className="report-modal-overlay" onClick={() => setShowFsModal(false)}>
                  <div className="report-modal-content" onClick={(e) => e.stopPropagation()}>
                    <div className="report-modal-header">
                      <h3>Анализ финансовой отчетности</h3>
                      <button onClick={() => setShowFsModal(false)} className="report-modal-close">×</button>
                    </div>
                    <div className="report-modal-body">
                      {(() => {
                        const fsReportText = selectedApplication.fsReportText || ''
                        if (!fsReportText || fsReportText === 'Анализ не готов') {
                          return <pre className="report-text">Анализ не готов</pre>
                        }
                        
                        const matches = [...fsReportText.matchAll(/\n\n={80,}\nОТЧЕТ\s+(\d+)\s+из\s+(\d+)\nФайл:\s*(.+?)\n={80,}\n\n/g)]
                        
                        if (matches.length > 0) {
                          return (
                            <div className="reports-list">
                              {matches.map((match, idx) => {
                                const reportNum = match[1]
                                const totalNum = match[2]
                                const fileName = match[3]
                                const startIndex = match.index + match[0].length
                                const endIndex = idx < matches.length - 1 ? matches[idx + 1].index : fsReportText.length
                                const reportContent = fsReportText.substring(startIndex, endIndex).trim()
                                
                                return (
                                  <div key={idx} className="report-file-section">
                                    <div className="report-file-header">
                                      <FileText size={16} />
                                      <h4>Отчет {reportNum} из {totalNum}: {fileName}</h4>
                                    </div>
                                    <pre className="report-text">{reportContent}</pre>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        } else {
                          return <pre className="report-text">{fsReportText}</pre>
                        }
                      })()}
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
