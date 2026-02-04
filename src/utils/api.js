// API configuration utility
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

// Helper function to build API URLs
export const getApiUrl = (endpoint) => {
  // If we have a base URL (production), use it
  if (API_BASE_URL) {
    return `${API_BASE_URL}${endpoint}`
  }
  // Otherwise use relative URLs (development)
  return endpoint
}

// API endpoints
export const API_ENDPOINTS = {
  AGENTS_RUN: '/api/agents/run',
  REPORTS: '/api/reports',
  REPORTS_BY_ID: (sessionId) => `/api/reports/${sessionId}`,
  REPORTS_DELETE: (sessionId) => `/api/reports/${sessionId}`
}

// Helper function to make API calls
export const apiCall = async (endpoint, options = {}) => {
  const url = getApiUrl(endpoint)
  console.log('🌐 API Call:', url)
  
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    })
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    
    return await response.json()
  } catch (error) {
    console.error('❌ API Error:', error)
    throw error
  }
}