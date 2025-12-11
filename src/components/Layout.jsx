import React, { useState } from 'react'
import Header from './Header'
import Sidebar from './Sidebar'
import MainContent from './MainContent'
import Applications from './Applications'
import Settings from './Settings'
import RightSidebar from './RightSidebar'
import './Layout.css'

const Layout = () => {
  const [activeView, setActiveView] = useState('chat') // 'chat', 'applications' или 'settings'

  const handleViewChange = (view) => {
    setActiveView(view)
  }

  const renderContent = () => {
    if (activeView === 'chat') {
      return <MainContent />
    } else if (activeView === 'applications') {
      return <Applications />
    } else if (activeView === 'settings') {
      return <Settings />
    }
    return <MainContent />
  }

  return (
    <div className="layout">
      <Header onLogoClick={() => handleViewChange('chat')} />
      <div className="layout-content">
        <Sidebar onViewChange={handleViewChange} activeView={activeView} />
        {renderContent()}
        {activeView !== 'settings' && <RightSidebar />}
      </div>
    </div>
  )
}

export default Layout


