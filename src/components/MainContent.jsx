import React, { useState } from 'react'
import AgentsChat from './AgentsChat'
import './MainContent.css'

const MainContent = () => {
  const [activeTab, setActiveTab] = useState('loan')

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

        <div className="chat-section">
          <AgentsChat />
        </div>
      </div>
    </main>
  )
}

export default MainContent
