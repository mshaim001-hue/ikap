import React from 'react'
import { FileText, Target, Paperclip, Eye, Info } from 'lucide-react'
import './RightSidebar.css'

const RightSidebar = () => {
  const steps = [
    { icon: FileText, label: 'Базовая информация', active: true },
    { icon: Target, label: 'Цели', active: false },
    { icon: Paperclip, label: 'Ваши инструменты', active: false },
    { icon: Eye, label: 'Выручка', active: false },
    { icon: Info, label: 'Информация о компании', active: false }
  ]

  return (
    <aside className="right-sidebar">
      <div className="steps-container">
        {steps.map((step, index) => (
          <div 
            key={index} 
            className={`step-item ${step.active ? 'active' : ''}`}
          >
            <div className="step-icon">
              <step.icon size={20} />
            </div>
            <span className="step-label">{step.label}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}

export default RightSidebar






