// Сервис для работы с OpenAI ChatKit
class OpenAIService {
  constructor() {
    // В реальном приложении API ключ должен быть в переменных окружения
    this.apiKey = import.meta.env.VITE_OPENAI_API_KEY || 'your-api-key-here'
    this.baseURL = 'https://api.openai.com/v1'
  }

  async sendMessage(messages, userMessage) {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `Ты - помощник по привлечению инвестиций для платформы iKapitalist. 
            Твоя задача - помочь пользователю зарегистрироваться для привлечения инвестиций.
            Задавай вопросы по порядку:
            1. Сумма инвестиций
            2. Срок займа
            3. Информация о компании
            4. Выручка компании
            5. Цели использования средств
            
            Будь дружелюбным и профессиональным. Отвечай на русском языке.
            Если пользователь не предоставил API ключ, сообщи ему об этом.`
          },
          ...messages,
          {
            role: 'user',
            content: userMessage
          }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`OpenAI API Error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`)
    }

    const data = await response.json()
    return data.choices[0].message.content
  }

}

export default new OpenAIService()
