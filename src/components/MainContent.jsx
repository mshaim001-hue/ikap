import React, { useState } from 'react'
import AgentsChat from './AgentsChat'
import './MainContent.css'

const StepBadge = ({ label, completed, hint }) => {
  const [showHint, setShowHint] = useState(false)
  return (
    <button
      className={`step-badge ${completed ? 'completed' : ''}`}
      onClick={() => setShowHint(v => !v)}
      title={hint}
    >
      <span className="step-check">{completed ? '✓' : '•'}</span>
      <span className="step-label">{label}</span>
      {showHint && (
        <div className="step-hint">{hint}</div>
      )}
    </button>
  )
}

const MainContent = () => {
  const [activeTab, setActiveTab] = useState('loan')
  const [progress, setProgress] = useState({ statements: false, taxes: false, financial: false })

  const tabs = [
    { id: 'loan', label: 'Привлечь займ', active: true },
    { id: 'bonds', label: 'Облигации', active: false },
    { id: 'share', label: 'Доля бизнеса', active: false }
  ]

  return (
    <main className="main-content">
      <div className="content-container">
        <h1 className="main-title">
          Я хочу привлечь инвестирование на компанию
        </h1>
        
        <div className="tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`tab ${tab.active ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Прогресс-бар шагов */}
        <div className="progress-steps">
          {[
            { key: 'statements', label: 'Выписки', hint: 'Пожалуйста, предоставьте актуальные выписки со всех счетов банков в формате PDF за последние 12 месяцев.' },
            { key: 'taxes', label: 'Налоги', hint: 'Загрузите налоговую отчетность за текущий и предыдущий год в формате ZIP.' },
            { key: 'financial', label: 'Фин. отчет', hint: 'Загрузите финансовую отчетность (баланс и ОПУ) за текущий и предыдущий год в формате ZIP.' }
          ].map(item => (
            <StepBadge
              key={item.key}
              label={item.label}
              completed={progress[item.key]}
              hint={item.hint}
            />
          ))}
        </div>

        <div className="chat-section">
          <AgentsChat onProgressChange={setProgress} />
        </div>
      </div>
    </main>
  )
}

export default MainContent
