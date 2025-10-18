// Сервис для работы с ChatKit и Agent Builder
class ChatKitService {
  constructor() {
    this.apiKey = import.meta.env.VITE_OPENAI_API_KEY
    this.baseURL = 'https://api.openai.com/v1'
    // Workflow ID для Agent Builder (замените на ваш реальный ID)
    this.workflowId = import.meta.env.VITE_CHATKIT_WORKFLOW_ID || 'wf_68df4b13b3588190a09d19288d4610ec0df388c3983f58d1'
  }

  async createSession(deviceId) {
    try {
      console.log('[chatkit] createSession start', {
        deviceId,
        workflowId: this.workflowId,
        apiKeyPresent: Boolean(this.apiKey)
      })
      const response = await fetch(`${this.baseURL}/chatkit/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'chatkit_beta=v1',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          workflow: { id: this.workflowId },
          user: deviceId
        })
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        console.error('[chatkit] createSession failed', response.status, text)
        throw new Error(`ChatKit API Error: ${response.status} - ${text}`)
      }

      const data = await response.json()
      console.log('[chatkit] createSession ok')
      return data.client_secret
    } catch (error) {
      console.error('ChatKit Session Creation Error:', error)
      throw error
    }
  }

  async refreshSession(existingSecret) {
    try {
      const response = await fetch(`${this.baseURL}/chatkit/sessions/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'chatkit_beta=v1',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          client_secret: existingSecret
        })
      })

      if (!response.ok) {
        throw new Error(`Session refresh failed: ${response.status}`)
      }

      const data = await response.json()
      return data.client_secret
    } catch (error) {
      console.error('Session refresh error:', error)
      throw error
    }
  }

  // Генерируем уникальный device ID для пользователя
  generateDeviceId() {
    return `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}

export default new ChatKitService()

