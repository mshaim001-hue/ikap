import React from 'react'
import { Menu, ChevronDown, User } from 'lucide-react'
import './Header.css'

const Header = () => {
  return (
    <header className="header">
      <div className="header-left">
        <button className="menu-button">
          <Menu size={20} />
        </button>
        <div className="logo">
          <div className="logo-icon">i</div>
          <span className="logo-text">iKapitalist</span>
        </div>
      </div>
      
      <div className="header-center">
        <button className="attract-financing-btn">
          Привлечь финансирование
        </button>
      </div>
      
      <div className="header-right">
        <div className="verification-status">
          <span className="verification-text">Верификация не пройдена</span>
          <ChevronDown size={16} />
        </div>
        <div className="user-profile">
          <User size={20} />
          <ChevronDown size={16} />
        </div>
      </div>
    </header>
  )
}

export default Header



