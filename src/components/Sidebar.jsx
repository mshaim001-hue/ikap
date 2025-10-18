import React from 'react'
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
  Coins 
} from 'lucide-react'
import './Sidebar.css'

const Sidebar = () => {
  const menuItems = [
    { icon: Users, label: 'Список сделок', active: false },
    { icon: Building, label: 'Портфель инвестора', active: false },
    { icon: Briefcase, label: 'Владелец бизнеса', active: true },
    { icon: Shield, label: 'Гарант', active: false },
    { icon: Calendar, label: 'Календарь платежей', active: false },
    { icon: FileText, label: 'Договоры', active: false },
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
          >
            <item.icon size={20} />
            <span className="nav-label">{item.label}</span>
            {item.badge && (
              <span className="badge">{item.badge}</span>
            )}
          </div>
        ))}
      </nav>
    </aside>
  )
}

export default Sidebar

