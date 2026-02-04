import React, { useState, useEffect } from 'react'
import { 
  Users, 
  Building, 
  Briefcase, 
  Shield, 
  Calendar, 
  FileText, 
  CreditCard, 
  Bell, 
  MessageCircle, 
  Coins,
  ClipboardList,
  Settings
} from 'lucide-react'
import { getApiUrl } from '../utils/api'
import './Sidebar.css'

const Sidebar = ({ onViewChange, activeView }) => {
  const [newApplicationsCount, setNewApplicationsCount] = useState(0)

  // Функция для получения количества новых заявок
  const fetchNewApplicationsCount = async () => {
    try {
      // В ikap2 нет эндпоинта /api/reports/new-count.
      // Берём общее количество из пагинации списка отчётов.
      const response = await fetch(getApiUrl('/api/reports?limit=1&offset=0'))
      if (response.ok) {
        const data = await response.json()
        setNewApplicationsCount(data?.pagination?.total || 0)
      }
    } catch (error) {
      console.error('Ошибка получения количества заявок:', error)
    }
  }

  // Загружаем количество заявок при монтировании компонента
  useEffect(() => {
    fetchNewApplicationsCount()
    
    // Обновляем каждые 10 минут
    const interval = setInterval(fetchNewApplicationsCount, 600000)
    
    return () => clearInterval(interval)
  }, [])

  const handleItemClick = (label) => {
    if (label === 'Заявки') {
      onViewChange('applications')
    } else if (label === 'Владелец бизнеса') {
      onViewChange('chat')
    } else if (label === 'Настройки') {
      onViewChange('settings')
    }
    // Для других пунктов можно добавить логику позже
  }

  const menuItems = [
    { icon: Users, label: 'Список сделок', active: false },
    { icon: Building, label: 'Портфель инвестора', active: false },
    { icon: Briefcase, label: 'Владелец бизнеса', active: activeView === 'chat' },
    { icon: Shield, label: 'Гарант', active: false },
    { icon: Calendar, label: 'Календарь платежей', active: false },
    { icon: FileText, label: 'Договоры', active: false },
    { icon: ClipboardList, label: 'Заявки', active: activeView === 'applications', badge: newApplicationsCount > 0 ? newApplicationsCount : null },
    { icon: Settings, label: 'Настройки', active: activeView === 'settings' },
    { icon: CreditCard, label: 'Платежи', active: false },
    { icon: Bell, label: 'Уведомления', active: false, badge: 5 },
    { icon: MessageCircle, label: 'Обращения', active: false },
    { icon: Coins, label: 'Дискуссии', active: false },
    { icon: Calendar, label: 'Календарь платежей компании', active: false }
  ]

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {menuItems.map((item, index) => (
          <div 
            key={index} 
            className={`nav-item ${item.active ? 'active' : ''}`}
            onClick={() => handleItemClick(item.label)}
          >
            <item.icon size={20} />
            <span className="nav-label">{item.label}</span>
            {item.badge && item.badge > 0 && (
              <span className="badge">{item.badge}</span>
            )}
          </div>
        ))}
      </nav>
    </aside>
  )
}

export default Sidebar

