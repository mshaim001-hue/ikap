import React, { useState } from 'react'
import Header from './Header'
import Sidebar from './Sidebar'
import MainContent from './MainContent'
import Applications from './Applications'
import RightSidebar from './RightSidebar'
import './Layout.css'

const Layout = () => {
  const [activeView, setActiveView] = useState('chat') // 'chat' или 'applications'

  const handleViewChange = (view) => {
    setActiveView(view)
  }

  return (
    <div className="layout">
      <Header onLogoClick={() => handleViewChange('chat')} />
      <div className="layout-content">
        <Sidebar onViewChange={handleViewChange} activeView={activeView} />
        {activeView === 'chat' ? <MainContent /> : <Applications />}
        <RightSidebar />
      </div>
    </div>
  )
}

export default Layout


