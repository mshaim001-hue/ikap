import React, { useState, useEffect, useRef, useMemo } from 'react'
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
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getApiUrl } from '../utils/api'
import './Applications.css'

const MONTH_NAMES_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const MONTH_NAMES_TABLE = ['Янв', 'Февр', 'Март', 'Апр', 'Май', 'Июнь', 'Июль', 'Авг', 'Сент', 'Окт', 'Нояб', 'Дек']

function formatStructuredDate(value) {
  if (!value) return '—'
  const valueStr = String(value)
  const ddmm = valueStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/)
  if (ddmm) {
    const [, dd, mm, yy] = ddmm
    let year = Number(yy)
    if (String(yy).length === 2) year += 2000
    const date = new Date(year, Number(mm) - 1, Number(dd))
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString('ru-RU', { year: 'numeric', month: 'short', day: 'numeric' })
    }
  }
  try {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('ru-RU', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch (_) {}
  return value
}

/** Парсит блок "Финансовые показатели" из текста отчёта, когда бэк не прислал fs_report_structured. */
function parseFsTableFromText(text) {
  if (!text || typeof text !== 'string') return null
  const idx = text.indexOf('Финансовые показатели')
  if (idx === -1) return null
  let block = text.slice(idx + 'Финансовые показатели'.length).trim()
  // Ограничиваем блок до следующего крупного заголовка или конца
  const nextSection = block.search(/\n\n[A-ZА-Я][a-zа-яё]*:/)
  if (nextSection > 0) block = block.slice(0, nextSection)
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  let years = []
  const table = []
  let headerFound = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Заголовок: "Показатель	2024	2023" или "| Показатель | 2024 | 2023 | 2022 |"
    if (!headerFound && (line.includes('Показатель') || line.startsWith('|'))) {
      const cells = line.split(/\t|\s*\|\s*/).map((c) => c.trim()).filter(Boolean)
      if (cells[0] === 'Показатель' || cells[0] === '') {
        const first = cells[0] === 'Показатель' ? cells.slice(1) : cells
        years = first.filter((c) => /^\d{4}$/.test(c) || c === '—' || c === '-')
        if (years.length === 0) years = first.filter((c) => c && c !== 'Показатель')
        headerFound = true
      }
      continue
    }
    if (!headerFound) continue

    // Строки вида "| A | 1 | 2 | | B | 3 | 4 |" — разбиваем на две строки таблицы
    const rowParts = line.split(/\s*\|\s*\|\s*/).map((p) => p.trim()).filter(Boolean)
    for (const part of rowParts) {
      const cells = part.split(/\t|\s*\|\s*/).map((c) => c.trim()).filter(Boolean)
      if (cells.length < 2) continue
      const indicator = cells[0]
      if (!indicator || /^\d{4}$/.test(indicator)) continue
      const values = {}
      years.forEach((y, j) => {
        const raw = cells[j + 1]
        if (raw === '—' || raw === '-' || raw === '' || raw == null) {
          values[y] = null
        } else {
          const num = Number(String(raw).replace(/\s/g, ''))
          values[y] = Number.isFinite(num) ? num : raw
        }
      })
      table.push({ indicator, values })
    }
  }

  if (years.length === 0 || table.length === 0) return null
  const summaryMatch = text.match(/Краткий анализ\s*[\r\n]+([^\n]+(?:\n(?!Финансовые показатели)[^\n]+)*)/i)
  const summary = summaryMatch ? summaryMatch[1].trim() : ''
  return { table, years, summary }
}

/** Таблица по годам и месяцам (выручка), как в ikap2 */
function RevenueTable({ structuredReport }) {
  if (!structuredReport?.revenue?.years?.length) return null
  const allYears = [...new Set(structuredReport.revenue.years.map(y => y.year))].sort()
  const getMonthValue = (yearData, monthIndex) => {
    if (!yearData?.months) return 0
    const month = yearData.months.find(m => m.monthIndex === monthIndex)
    return month?.value || 0
  }
  return (
    <div className="revenue-table-container">
      <table className="revenue-table">
        <thead>
          <tr>
            <th>Названия строк</th>
            <th>Сумма по полю Кредит</th>
          </tr>
        </thead>
        <tbody>
          {allYears.map(year => {
            const revenueYear = structuredReport.revenue.years.find(y => y.year === year)
            return (
              <React.Fragment key={year}>
                <tr className="year-row">
                  <td colSpan="2"><strong>Год {year}</strong></td>
                </tr>
                {MONTH_NAMES_TABLE.map((monthName, monthIndex) => {
                  const revenueValue = revenueYear ? getMonthValue(revenueYear, monthIndex) : 0
                  return (
                    <tr key={`${year}-${monthIndex}`}>
                      <td>{monthName}</td>
                      <td>{revenueValue.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    </tr>
                  )
                })}
                <tr className="year-total-row">
                  <td><strong>Итого за {year}</strong></td>
                  <td>
                    {(revenueYear?.value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              </React.Fragment>
            )
          })}
          <tr className="grand-total-row">
            <td><strong>Общий итог</strong></td>
            <td>
              {(structuredReport.revenue?.totalValue || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function RevenueChart({ structuredReport }) {
  if (!structuredReport?.revenue?.years?.length) return null
  const chartData = []
  const allYears = [...new Set(structuredReport.revenue.years.map(y => y.year))].sort()
  allYears.forEach((year) => {
    const revenueYear = structuredReport.revenue.years.find(y => y.year === year)
    if (!revenueYear?.months) return
    revenueYear.months.forEach((month) => {
      chartData.push({
        month: MONTH_NAMES_SHORT[month.monthIndex] ?? month.month,
        year: year,
        value: month.value || 0,
        fullLabel: `${MONTH_NAMES_SHORT[month.monthIndex] ?? month.month} ${year}`,
      })
    })
  })
  if (chartData.length === 0) return null
  return (
    <div className="revenue-chart-container">
      <h4>Связанные стороны</h4>
      <ResponsiveContainer width="100%" height={400}>
        <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="fullLabel" angle={-45} textAnchor="end" height={100} interval={0} />
          <YAxis />
          <Tooltip formatter={(value) => value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Legend />
          <Bar dataKey="value" fill="#8884d8" name="Кредит" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function StatementReportContent({ reportText, reportStructured }) {
  const structured = useMemo(() => {
    if (!reportStructured) return null
    if (typeof reportStructured === 'object') return reportStructured
    try {
      return JSON.parse(reportStructured)
    } catch {
      return null
    }
  }, [reportStructured])

  // Для ikap нам нужен только агрегированный анализ: сводка по выручке + график,
  // без списков операций (AutoRevenue / AgentReview). Если есть структурированный
  // отчёт с revenue.years — всегда показываем его в этом виде.
  if (structured?.revenue?.years?.length) {
    return (
      <div className="statement-report-ikap2">
        <h3 className="report-section-title">Сводка по выручке</h3>
        <RevenueTable structuredReport={structured} />
        <RevenueChart structuredReport={structured} />
      </div>
    )
  }

  const text = reportText || ''
  const matches = [...text.matchAll(/\n\n={80,}\nОТЧЕТ\s+(\d+)\s+из\s+(\d+)\nФайл:\s*(.+?)\n={80,}\n\n/g)]
  if (matches.length > 0) {
    return (
      <div className="reports-list">
        {matches.map((match, idx) => {
          const startIndex = match.index + match[0].length
          const endIndex = idx < matches.length - 1 ? matches[idx + 1].index : text.length
          const reportContent = text.substring(startIndex, endIndex).trim()
          return (
            <div key={idx} className="report-file-section">
              <div className="report-file-header">
                <FileText size={16} />
                <h4>Отчет {match[1]} из {match[2]}: {match[3]}</h4>
              </div>
              <pre className="report-text">{reportContent}</pre>
            </div>
          )
        })}
      </div>
    )
  }
  return <pre className="report-text">{text || 'Нет данных'}</pre>
}

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
  const [showOverviewModal, setShowOverviewModal] = useState(false)
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
                  const hasReport = !!selectedApplication.reportText || !!selectedApplication.reportStructured
                  const isCompleted = selectedApplication.status === 'completed' && hasReport
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

                {/* Комплектность документов (onepage) */}
                {(() => {
                  const hasOverview = !!selectedApplication.docsOverviewJson || !!selectedApplication.docsOverviewText
                  return (
                    <button
                      onClick={() => hasOverview && setShowOverviewModal(true)}
                      className={`analysis-button ${hasOverview ? 'enabled' : 'disabled'}`}
                      disabled={!hasOverview}
                      title={hasOverview ? 'Открыть отчёт о комплектности документов' : 'Проверка комплектности ещё не выполнена'}
                    >
                      <Paperclip size={16} />
                      Комплектность документов
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

            

              {/* Модальное окно для просмотра отчета (таблица + график как в ikap2 или текст) */}
              {showStatementsModal && selectedApplication && (selectedApplication.reportText || selectedApplication.reportStructured) && (
                <div className="report-modal-overlay" onClick={() => setShowStatementsModal(false)}>
                  <div className="report-modal-content report-modal-content--wide" onClick={(e) => e.stopPropagation()}>
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
                      <StatementReportContent
                        reportText={selectedApplication.reportText}
                        reportStructured={selectedApplication.reportStructured}
                      />
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
                          return <div className="report-text">Анализ не готов</div>
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
                                    <div className="report-markdown">
                                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportContent}</ReactMarkdown>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        }
                        return (
                          <div className="report-markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{taxReportText}</ReactMarkdown>
                          </div>
                        )
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
                        const fsReportStructuredRaw = selectedApplication.fsReportStructured

                        // Если есть структурированные данные от ikap4 — рендерим таблицу как в UI pdftopng
                        let structured = null
                        if (fsReportStructuredRaw) {
                          if (typeof fsReportStructuredRaw === 'object') {
                            structured = fsReportStructuredRaw
                          } else {
                            try {
                              structured = JSON.parse(String(fsReportStructuredRaw))
                            } catch (_) {
                              structured = null
                            }
                          }
                        }

                        // Фоллбек: парсим таблицу из текста, если структура пустая (бэк не прислал или старый отчёт)
                        if ((!structured || !structured.table?.length || !structured.years?.length) && fsReportText && fsReportText.includes('Финансовые показатели')) {
                          const parsed = parseFsTableFromText(fsReportText)
                          if (parsed && parsed.table?.length > 0 && parsed.years?.length > 0) {
                            structured = parsed
                          }
                        }

                        if (structured && Array.isArray(structured.table) && Array.isArray(structured.years) && structured.table.length > 0 && structured.years.length > 0) {
                          const years = structured.years
                          const rows = structured.table
                          const summary = structured.summary || ''

                          return (
                            <>
                              {summary && (
                                <div className="report-text" style={{ marginBottom: 16 }}>
                                  {summary}
                                </div>
                              )}
                              <div className="table-wrap">
                                <table className="auto-revenue-table">
                                  <thead>
                                    <tr>
                                      <th>Показатель</th>
                                      {years.map((y) => (
                                        <th key={y}>{y}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rows.map((row, idx) => (
                                      <tr key={idx}>
                                        <td>{row.indicator || ''}</td>
                                        {years.map((y) => {
                                          const v = row.values?.[y]
                                          return (
                                            <td key={y}>
                                              {typeof v === 'number'
                                                ? v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })
                                                : v ?? '—'}
                                            </td>
                                          )
                                        })}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )
                        }

                        // Фоллбек на текстовый отчёт (markdown), если structured нет
                        if (!fsReportText || fsReportText === 'Анализ не готов') {
                          return <div className="report-text">Анализ не готов</div>
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
                                    <div className="report-markdown">
                                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportContent}</ReactMarkdown>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        }
                        return (
                          <div className="report-markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fsReportText}</ReactMarkdown>
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {showOverviewModal && selectedApplication && (() => {
                const json = selectedApplication.docsOverviewJson
                const text = selectedApplication.docsOverviewText || ''
                let parsed = null
                if (json) {
                  try {
                    parsed = typeof json === 'object' ? json : JSON.parse(String(json))
                  } catch (_) {
                    parsed = null
                  }
                }
                return (
                  <div className="report-modal-overlay" onClick={() => setShowOverviewModal(false)}>
                    <div className="report-modal-content" onClick={(e) => e.stopPropagation()}>
                      <div className="report-modal-header">
                        <h3>Комплектность документов</h3>
                        <button onClick={() => setShowOverviewModal(false)} className="report-modal-close">×</button>
                      </div>
                      <div className="report-modal-body">
                        {parsed ? (
                          <div className="docs-overview-content">
                            {(parsed.completeness?.isComplete !== undefined || parsed.completeness?.overallComplete !== undefined) && (
                              <p style={{ marginBottom: 12, fontWeight: 600, color: (parsed.completeness.isComplete ?? parsed.completeness.overallComplete) ? '#059669' : '#b45309' }}>
                                {(parsed.completeness.isComplete ?? parsed.completeness.overallComplete) ? '✓ Пакет документов полный' : '⚠ Не все документы представлены'}
                              </p>
                            )}
                            {parsed.summaryText && (
                              <p style={{ marginBottom: 12, fontSize: 13, color: '#6b7280' }}>{parsed.summaryText}</p>
                            )}
                            {parsed.completeness?.bankStatements && (parsed.completeness.bankStatements.present?.length > 0 || parsed.completeness.bankStatements.missing?.length > 0) && (
                              <div style={{ marginBottom: 16 }}>
                                <h4 style={{ marginBottom: 8, fontSize: 14 }}>Банковские выписки</h4>
                                {parsed.completeness.bankStatements.present?.length > 0 && (
                                  <p style={{ color: '#059669', fontSize: 13 }}>
                                    Есть: {parsed.completeness.bankStatements.present.map(p => {
                                      if (typeof p !== 'object' || p === null) return String(p)
                                      const y = p.year
                                      const c = p.coverage || p.description
                                      return c ? `${y}, период ${c}` : String(y ?? '')
                                    }).join('; ')}
                                  </p>
                                )}
                                {parsed.completeness.bankStatements.missing?.length > 0 && (
                                  <p style={{ color: '#b45309', fontSize: 13 }}>
                                    Не хватает выписок за период: {parsed.completeness.bankStatements.missing.map(m => {
                                      if (typeof m !== 'object' || m === null) return String(m)
                                      return m.missingPeriods || m.description || m.year ?? ''
                                    }).join('; ')}
                                  </p>
                                )}
                              </div>
                            )}
                            {parsed.completeness?.taxReports && (parsed.completeness.taxReports.present?.length > 0 || parsed.completeness.taxReports.missing?.length > 0) && (
                              <div style={{ marginBottom: 16 }}>
                                <h4 style={{ marginBottom: 8, fontSize: 14 }}>Налоговая отчётность</h4>
                                {parsed.completeness.taxReports.present?.length > 0 && (
                                  <p style={{ color: '#059669', fontSize: 13 }}>
                                    Есть: {parsed.completeness.taxReports.present.map(p => {
                                      if (typeof p !== 'object' || p === null) return ''
                                      const parts = [p.form && p.year ? `форма ${p.form} ${p.year}` : '']
                                      if (p.period) parts.push(p.period)
                                      if (p.declarationType) parts.push(`(${p.declarationType})`)
                                      return parts.filter(Boolean).join(' ')
                                    }).filter(Boolean).join('; ')}
                                  </p>
                                )}
                                {parsed.completeness.taxReports.missing?.length > 0 && (
                                  <p style={{ color: '#b45309', fontSize: 13 }}>
                                    Не хватает: {parsed.completeness.taxReports.missing.map(m => {
                                      if (typeof m !== 'object' || m === null) return ''
                                      const parts = [m.form && m.year ? `форма ${m.form} ${m.year}` : '']
                                      if (m.period) parts.push(m.period)
                                      return parts.filter(Boolean).join(' ')
                                    }).filter(Boolean).join('; ')}
                                  </p>
                                )}
                              </div>
                            )}
                            {parsed.completeness?.financialReports && (parsed.completeness.financialReports.present?.length > 0 || parsed.completeness.financialReports.missing?.length > 0) && (
                              <div style={{ marginBottom: 16 }}>
                                <h4 style={{ marginBottom: 8, fontSize: 14 }}>Финансовая отчётность</h4>
                                {(() => {
                                  const formNames = { BB: 'Бухгалтерский баланс', OIK: 'Отчёт об изменениях в капитале', OSD: 'Отчёт о совокупном доходе', ODDS: 'Отчёт о движении денежных средств', OSV: 'Оборотно-сальдовая ведомость' }
                                  const fmt = (x) => {
                                    if (typeof x !== 'object' || x === null) return ''
                                    const name = formNames[x.formCode] || x.formName || x.formCode || '?'
                                    return x.year ? `${name} ${x.year}` : name
                                  }
                                  return (
                                    <>
                                      {parsed.completeness.financialReports.present?.length > 0 && (
                                        <p style={{ color: '#059669', fontSize: 13 }}>Есть: {parsed.completeness.financialReports.present.map(fmt).filter(Boolean).join('; ')}</p>
                                      )}
                                      {parsed.completeness.financialReports.missing?.length > 0 && (
                                        <p style={{ color: '#b45309', fontSize: 13 }}>Не хватает: {parsed.completeness.financialReports.missing.map(fmt).filter(Boolean).join('; ')}</p>
                                      )}
                                    </>
                                  )
                                })()}
                              </div>
                            )}
                            {Array.isArray(parsed.documents) && parsed.documents.length > 0 && (
                              <div>
                                <h4 style={{ marginBottom: 8, fontSize: 14 }}>Документы в пакете</h4>
                                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
                                  {parsed.documents.map((doc, i) => (
                                    <li key={i}>{doc.originalName ?? doc.original_name ?? `Документ ${(doc.documentIndex ?? doc.document_index) ?? i + 1}`}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        ) : text ? (
                          <div className="report-text" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
                        ) : (
                          <div className="report-text">Нет данных о комплектности</div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })()}
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
