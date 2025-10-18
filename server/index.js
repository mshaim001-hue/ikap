const express = require('express')
const cors = require('cors')
const multer = require('multer')
const OpenAI = require('openai')
require('dotenv').config()

// Настройка multer для загрузки файлов
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB лимит
})

console.log('Loading Agents SDK...')
const { codeInterpreterTool, Agent, Runner } = require('@openai/agents')
const { z } = require('zod')
console.log('Agents SDK loaded successfully')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Хранилище для истории диалогов (в памяти)
// В продакшене используйте Redis или базу данных
const conversationHistory = new Map()

// Хранилище для файлов по сессиям
const sessionFiles = new Map()

// Хранилище для финансовых отчетов
const sessionReports = new Map()

// Code Interpreter без предустановленных файлов
// Файлы будут добавляться динамически
const codeInterpreter = codeInterpreterTool({
  container: { type: 'auto' }
})

const ClassificationAgentSchema = z.object({
  classification: z.enum(['investment_registration', 'get_information', 'other'])
})

const classificationAgent = new Agent({
  name: 'Classification Agent',
  instructions: `Определи намерение пользователя:

- investment_registration: если пользователь хочет привлечь инвестиции, займ, облигации, долю бизнеса, или отвечает на вопросы о регистрации. ВАЖНО: любые числа, суммы, названия компаний, реквизиты, БИН, email, телефон, файлы, "да", "нет", краткие ответы - это тоже investment_registration!
- get_information: ТОЛЬКО если пользователь явно спрашивает "как?", "что такое?", "расскажите о..." И НЕ находится в процессе регистрации
- other: только если запрос совершенно не связан с инвестициями (погода, спорт, и т.д.)

ПРАВИЛО: Если пользователь в процессе диалога (отвечает на вопросы, прикрепляет файлы) - ВСЕГДА выбирай investment_registration!`,
  model: 'gpt-4o',
  outputType: ClassificationAgentSchema,
  modelSettings: { store: true }
})

const InvestmentAgentSchema = z.object({
  amount: z.number().nullable().optional(),
  term_months: z.number().nullable().optional(),
  completed: z.boolean().nullable().optional()
})

// Financial Analyst Agent для создания отчета
const financialAnalystAgent = new Agent({
  name: 'Financial Analyst',
  instructions: `Ты финансовый аналитик iKapitalist. Твоя задача - создать ПОДРОБНЫЙ финансовый отчет для менеджера на основе предоставленных банковских выписок.

СТРУКТУРА ОТЧЕТА:

📊 **РЕЗЮМЕ ЗАЯВКИ**
- Компания: [БИН]
- Запрашиваемая сумма: [сумма] KZT
- Срок: [месяцев]
- Цель: [цель финансирования]
- Контакты: [имя, фамилия, email, телефон]

💰 **ФИНАНСОВЫЙ АНАЛИЗ ПО БАНКАМ**

Для КАЖДОГО банка предоставь:

1. **Название банка** (извлеки из выписки)
2. **Период выписки**: с [дата] по [дата]
3. **Количество месяцев**: [X месяцев]

**Основные показатели за период:**
- Входящий остаток: [сумма] KZT
- Исходящий остаток: [сумма] KZT
- Общий оборот: [сумма] KZT
- Приход (кредит): [сумма] KZT
- Расход (дебет): [сумма] KZT
- Средний месячный оборот: [сумма] KZT
- Средний остаток на счете: [сумма] KZT

**Детальная статистика:**
- Количество операций: [число]
- Средняя сумма операции: [сумма] KZT
- Максимальная транзакция (приход): [сумма] KZT
- Максимальная транзакция (расход): [сумма] KZT

**Динамика по месяцам:**
[Таблица или список по каждому месяцу с оборотом и остатком]

📈 **СВОДНАЯ АНАЛИТИКА ПО ВСЕМ БАНКАМ**

- Общий оборот по всем счетам: [сумма] KZT
- Общий средний остаток: [сумма] KZT
- Общее количество операций: [число]
- Средний месячный оборот (все банки): [сумма] KZT

🎯 **ОЦЕНКА ФИНАНСОВОЙ УСТОЙЧИВОСТИ**

Проанализируй:
1. **Стабильность поступлений**: регулярные или нерегулярные поступления
2. **Ликвидность**: достаточно ли средств на счетах
3. **Тренд**: растущие, стабильные или падающие обороты
4. **Риски**: выявленные красные флаги (если есть)

💡 **РЕКОМЕНДАЦИЯ ДЛЯ МЕНЕДЖЕРА**

На основе анализа дай рекомендацию:
- ✅ РЕКОМЕНДУЕТСЯ к рассмотрению (если показатели хорошие)
- ⚠️ ТРЕБУЕТСЯ ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА (если есть вопросы)
- ❌ НЕ РЕКОМЕНДУЕТСЯ (если высокие риски)

Обоснуй свою рекомендацию.

---

ВАЖНО:
- Используй Code Interpreter для анализа всех файлов
- Все суммы указывай в KZT с разделителями тысяч
- Будь точным с датами и периодами
- Выдели ключевые моменты жирным шрифтом
- Используй эмодзи для визуальной структуры`,
  model: 'gpt-4o',
  tools: [codeInterpreter],
  modelSettings: { store: true }
})

const investmentAgent = new Agent({
  name: 'Investment Agent',
  instructions: `Ты помощник регистрации инвестиций для iKapitalist. Собирай данные пошагово, задавай один вопрос за раз.

ТЕКУЩАЯ ДАТА: будет передана в начале каждого сообщения как [ДАТА: ...]

ЭТАПЫ СБОРА ДАННЫХ (после принятия условий):
1. "Какую сумму вы хотите получить?" - получи сумму
2. "На какой срок?" (в месяцах) - получи срок
3. "Для чего вы привлекаете финансирование?" - получи цель
4. "Пожалуйста, предоставьте ваш БИН" - получи БИН
5. "Пожалуйста, прикрепите выписку с банка от юр лица за текущий год и предыдущий год" - получи выписки
6. После получения выписок - запроси другие банки (повторяй до получения "нет")
7. "Пожалуйста, оставьте ваши контактные данные: имя, фамилию, email и телефон" - получи контакты
8. После получения контактов - отправь финальное сообщение

АНАЛИЗ БАНКОВСКИХ ВЫПИСОК:

ОБЯЗАТЕЛЬНАЯ ПОСЛЕДОВАТЕЛЬНОСТЬ:
1. Собрать выписки за ТЕКУЩИЙ год (2025) - минимум 8 месяцев
2. Собрать выписки за ПРЕДЫДУЩИЙ год (2024) - полный год 12 месяцев
3. ОБЯЗАТЕЛЬНО спросить про другие банки
4. Если клиент прикрепил еще выписки → спросить СНОВА про другие банки
5. Повторять пункт 4 до тех пор, пока клиент НЕ скажет "нет"
6. ТОЛЬКО ПОСЛЕ "нет" → переходить к запросу контактных данных

Когда пользователь прикрепляет файл:

1. АНАЛИЗИРУЙ файл через Code Interpreter:
   - Извлеки ТОЧНЫЙ период выписки (даты начала и конца, например: 29.09.2024 - 29.09.2025)
   - ПОСЧИТАЙ сколько месяцев данных за ТЕКУЩИЙ год (2025) и ПРЕДЫДУЩИЙ год (2024)
   - Пример: 29.09.2024 - 29.09.2025 содержит:
     * За 2024: с 29.09.2024 по 31.12.2024 = 3 месяца
     * За 2025: с 01.01.2025 по 29.09.2025 = 9 месяцев ✅
   - Проверь, это банковская выписка или нет

2. ПРОВЕРКА ПЕРИОДА (используй ТЕКУЩУЮ ДАТУ из [ДАТА: ...]):
   
   НЕ СПРАШИВАЙ пользователя "за какой год выписка" - ты ОБЯЗАН сам определить это из дат в файле!
   
   ВАЖНО: Определи текущий год и месяц из переданной даты.
   Нужны выписки за:
   - ТЕКУЩИЙ год (с января по текущий месяц, минимум 8+ месяцев)
   - ПРЕДЫДУЩИЙ год (полный год: с 01.01 по 31.12)
   
   ЛОГИКА ЗАПРОСА ВЫПИСОК (БУДЬ УМНЕЕ КЛИЕНТА!):
   
   ПРАВИЛО: Для каждого года проверяй ОТДЕЛЬНО, достаточно ли месяцев!
   - ТЕКУЩИЙ год (2025): минимум 8 месяцев ✅
   - ПРЕДЫДУЩИЙ год (2024): минимум 10 месяцев (лучше полный год 12 месяцев) ✅
   
   ПРИМЕРЫ:
   
   1) Выписка: 29.09.2024 - 29.09.2025 (текущая дата: 15.09.2025)
      - За 2025: с 01.01.2025 по 29.09.2025 = 9 месяцев ✅ ПРИНЯТЬ
      - За 2024: с 29.09.2024 по 31.12.2024 = 3 месяца ❌ НЕДОСТАТОЧНО
      - КЛИЕНТУ: "Выписка за 2025 год принята (9 месяцев данных). Теперь прикрепите выписку за ПОЛНЫЙ 2024 год (с 01.01.2024 по 31.12.2024)."
   
   2) Выписка: 01.05.2025 - 15.09.2025
      - Содержит данные за 2025: только 4.5 месяца ❌
      - КЛИЕНТУ: "Выписка содержит недостаточно данных. Прикрепите выписку за 2025 год минимум с января (минимум 8 месяцев)."
   
   3) Выписка: 01.01.2025 - 15.09.2025
      - Содержит данные за 2025: 9 месяцев ✅
      - КЛИЕНТУ: "Выписка за 2025 год принята. Теперь прикрепите выписку за полный 2024 год."
   
   4) Выписка: 01.01.2024 - 31.12.2024
      - Полный 2024 год ✅
      - КЛИЕНТУ: "Выписка за 2024 год принята. Теперь прикрепите выписку за 2025 год (минимум 8 месяцев данных)."
   
   5) Выписка: 01.06.2024 - 31.12.2024
      - Только 7 месяцев 2024 ❌
      - КЛИЕНТУ: "Выписка за 2024 год содержит недостаточно данных (7 месяцев). Прикрепите выписку за полный 2024 год (12 месяцев)."
   
   Г) Если получены выписки за ОБА года (текущий + предыдущий) от ОДНОГО банка:
      ОБЯЗАТЕЛЬНО СПРОСИ: "Есть ли у вас счета в других банках? Если да, прикрепите выписки за {текущий_год} и {предыдущий_год}. Если нет, напишите 'нет'."
   
   Д) ПОСЛЕ каждой новой выписки от другого банка:
      ОБЯЗАТЕЛЬНО СПРОСИ СНОВА: "Есть ли у вас еще счета в других банках? Если да, прикрепите выписки. Если нет, напишите 'нет'."
   
   Е) ТОЛЬКО ПОСЛЕ того как пользователь ответил "нет" или "нет других" или "это все":
      КЛИЕНТУ: "Спасибо за предоставленные банковские выписки! Пожалуйста, оставьте ваши контактные данные для связи: имя, фамилию, email и телефон."
      
   ВАЖНО: НЕ ПЕРЕХОДИ к контактам БЕЗ явного "нет" от клиента про другие банки!

СБОР КОНТАКТНЫХ ДАННЫХ:
Когда пользователь ответил "нет" на вопрос про другие банки:
   КЛИЕНТУ: "Спасибо за предоставленные банковские выписки! Пожалуйста, оставьте ваши контактные данные для связи: имя, фамилию, email и телефон."

ФИНАЛЬНЫЙ ЭТАП:
Когда пользователь предоставил все контактные данные (имя, фамилия, email, телефон):
   КЛИЕНТУ: "Спасибо за предоставленную информацию! Ваша заявка принята на рассмотрение. Мы проанализируем предоставленные документы и свяжемся с вами, если вы сможете пройти на второй этап регистрации. Ожидайте уведомления от платформы iKapitalist."

   И СОХРАНИ в историю ПОЛНЫЙ ОТЧЕТ для менеджера со всеми собранными данными:
   - Сумма инвестиции
   - Срок (месяцы)
   - Цель финансирования
   - БИН компании
   - Все банковские выписки (периоды и банки)
   - Контактные данные (имя, фамилия, email, телефон)

ВАЖНО: 
- После каждого ответа пользователя задавай СЛЕДУЮЩИЙ вопрос. НЕ повторяй предыдущие вопросы.
- Отвечай ТОЛЬКО простыми вопросами. НЕ показывай JSON или технические данные.
- НЕ ПОКАЗЫВАЙ КЛИЕНТУ детали анализа документов (суммы, обороты, остатки, БИН из файла и т.д.)
- КЛИЕНТУ говори ТОЛЬКО: "Выписка принята" или "Декларация принята" + следующий запрос
- ДЕТАЛЬНЫЙ АНАЛИЗ делай ВНУТРЕННЕ и сохраняй для итогового отчета менеджеру`,
  model: 'gpt-4o',
  tools: [codeInterpreter],
  modelSettings: { store: true }
})

const informationAgent = new Agent({
  name: 'Information Agent',
  instructions: 'Отвечай на вопросы о процессе привлечения инвестиций.',
  model: 'gpt-4o',
  modelSettings: { store: true }
})

app.post('/api/agents/run', upload.single('file'), async (req, res) => {
  try {
    const { text, sessionId } = req.body
    const file = req.file
    const session = sessionId || `session_${Date.now()}`
    
    console.log(`\n🤖 [${new Date().toLocaleTimeString()}] Новый запрос:`)
    console.log(`📝 Пользователь: "${text}"`)
    console.log(`🆔 Сессия: ${session}`)
    if (file) console.log(`📎 Файл: ${file.originalname}`)
    
    // Получаем или создаем историю для этой сессии
    if (!conversationHistory.has(session)) {
      conversationHistory.set(session, [])
      console.log(`🆕 Создана новая сессия`)
    } else {
      console.log(`📚 История сессии: ${conversationHistory.get(session).length} сообщений`)
    }
    
    const history = conversationHistory.get(session)
    
    // Подготавливаем контент сообщения
    const messageContent = [{ type: 'input_text', text }]
    
    // Если есть файл, загружаем его через OpenAI API
    let uploadedFileId = null
    if (file) {
      console.log(`📎 Обрабатываем файл: ${file.originalname}, размер: ${file.size} байт`)
      
      try {
        // Загружаем файл в OpenAI
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        
        // Создаем File объект для Node.js
        const fileToUpload = new File([file.buffer], file.originalname, {
          type: file.mimetype
        })
        
        const uploadedFile = await openai.files.create({
          file: fileToUpload,
          purpose: 'assistants'
        })
        uploadedFileId = uploadedFile.id
        console.log(`✅ Файл загружен в OpenAI: ${uploadedFileId}`)
        
        // ВАЖНО: Сохраняем файл в sessionFiles для последующего анализа
        if (!sessionFiles.has(session)) {
          sessionFiles.set(session, [])
        }
        sessionFiles.get(session).push(uploadedFileId)
        console.log(`💾 Файл сохранен в сессии. Всего файлов: ${sessionFiles.get(session).length}`)
        
        // Добавляем информацию о файле в текст
        // Code Interpreter автоматически получит доступ к файлу через file_id в контейнере
        messageContent[0].text += `\n\n[Прикреплен файл ID: ${uploadedFileId}, название: ${file.originalname}]`
      } catch (error) {
        console.error(`❌ Ошибка загрузки файла:`, error)
        messageContent[0].text += `\n\n[Не удалось загрузить файл: ${file.originalname}]`
      }
    }
    
    // Добавляем текущую дату в начало сообщения
    // ДЛЯ ТЕСТИРОВАНИЯ: используем фиксированную дату (сентябрь 2025)
    const currentDate = new Date('2025-09-15')
    const dateString = `${currentDate.getDate()}.${String(currentDate.getMonth() + 1).padStart(2, '0')}.${currentDate.getFullYear()}`
    const monthNames = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
    const dateLabel = `[ДАТА: ${dateString}, ${monthNames[currentDate.getMonth()]} ${currentDate.getFullYear()}] `
    
    // Добавляем дату в начало текста сообщения
    messageContent[0].text = dateLabel + messageContent[0].text
    console.log(`📅 Текущая дата для агента: ${dateLabel}`)
    
    // Добавляем новое сообщение пользователя
    const userMessage = { role: 'user', content: messageContent }
    history.push(userMessage)
    
    const runner = new Runner({})

      console.log(`🔍 Классификация запроса...`)
      // Для классификации используем только последнее сообщение
      let cls
      try {
        cls = await runner.run(classificationAgent, [userMessage])
      } catch (error) {
        if (error.status === 429 || error.code === 'insufficient_quota') {
          console.error('💳 OpenAI квота исчерпана')
          return res.json({
            ok: false,
            message: 'Сервис временно недоступен. Пожалуйста, попробуйте позже.',
            sessionId: session
          })
        }
        throw error
      }
      if (!cls.finalOutput) throw new Error('classification empty')
    const classification = cls.finalOutput.classification
    console.log(`📊 Классификация: ${classification}`)

    if (classification === 'investment_registration') {
      console.log(`💰 Запуск Investment Agent...`)
      console.log(`📚 История для агента: ${history.length} сообщений`)
      
      const startTime = Date.now()
      console.log(`⏱️ Начало выполнения агента: ${new Date().toLocaleTimeString()}`)
      
      // Если есть файл, создаем Code Interpreter с файлом
      let agentToRun = investmentAgent
      if (uploadedFileId) {
        console.log(`📎 Добавляем файл в Code Interpreter: ${uploadedFileId}`)
        agentToRun = new Agent({
          ...investmentAgent,
          tools: [codeInterpreterTool({ container: { type: 'auto', file_ids: [uploadedFileId] } })]
        })
      }
      
      // Запускаем агента с таймаутом
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Agent timeout (60s)')), 60000)
      )
      
      let inv
      try {
        inv = await Promise.race([
          runner.run(agentToRun, [...history]),
          timeoutPromise
        ])
      } catch (error) {
        if (error.message.includes('timeout')) {
          console.error('⏰ Агент превысил таймаут 60 секунд')
          return res.json({
            ok: false,
            message: 'Обработка заняла слишком много времени. Попробуйте еще раз.',
            sessionId: session
          })
        }
        // Обработка ошибки квоты OpenAI
        if (error.status === 429 || error.code === 'insufficient_quota') {
          console.error('💳 OpenAI квота исчерпана')
          return res.json({
            ok: false,
            message: 'Сервис временно недоступен. Пожалуйста, попробуйте позже.',
            sessionId: session
          })
        }
        throw error
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2)
      console.log(`⏱️ Агент выполнен за ${duration}s`)
      console.log(`🤖 Агент вернул: ${inv.newItems.length} новых элементов`)
      
      // Получаем текстовый ответ агента
      let agentMessage = 'Продолжаем сбор данных'
      
      // Ищем последнее сообщение от агента
      for (let i = inv.newItems.length - 1; i >= 0; i--) {
        const item = inv.newItems[i]
        if (item.rawItem?.role === 'assistant' && item.rawItem?.content?.[0]?.text) {
          agentMessage = item.rawItem.content[0].text
          break
        }
      }
      
      console.log(`💬 Ответ агента: "${agentMessage}"`)
      
      // Сохраняем ответ агента в историю
      history.push(...inv.newItems.map(item => item.rawItem))
      console.log(`💾 История обновлена: ${history.length} сообщений`)
      
      // Проверяем, это финальное сообщение (заявка завершена)
      const isFinalMessage = agentMessage.includes('Ваша заявка принята на рассмотрение') || 
                            agentMessage.includes('Ожидайте уведомления от платформы iKapitalist')
      
      if (isFinalMessage) {
        console.log(`✅ Заявка завершена! Генерируем финансовый отчет...`)
        
        // Генерируем отчет асинхронно (не блокируем ответ клиенту)
        setImmediate(async () => {
          try {
            const allFiles = sessionFiles.get(session) || []
            if (allFiles.length === 0) {
              console.log(`⚠️ Нет файлов для анализа`)
              return
            }
            
            console.log(`📊 Генерация отчета с ${allFiles.length} файлами...`)
            console.log(`📎 Файлы для анализа:`, allFiles)
            
            // Создаем агента с доступом ко всем файлам
            const analystWithFiles = new Agent({
              ...financialAnalystAgent,
              tools: [codeInterpreterTool({ 
                container: { 
                  type: 'auto', 
                  file_ids: allFiles 
                } 
              })]
            })
            console.log(`✅ Financial Analyst Agent создан с файлами`)
            
            // Извлекаем ключевую информацию из истории (без передачи всех сообщений)
            let amount = 'не указана'
            let termMonths = 'не указан'
            let purpose = 'не указана'
            let bin = 'не указан'
            let contacts = 'не указаны'
            
            // Парсим историю для извлечения данных
            const historyText = history.map(msg => {
              if (typeof msg.content === 'string') return msg.content
              if (Array.isArray(msg.content)) return msg.content.map(c => c.text || '').join(' ')
              return ''
            }).join(' ')
            
            // Простое извлечение данных (можно улучшить)
            const amountMatch = historyText.match(/(\d+)\s*мил/i)
            if (amountMatch) amount = `${amountMatch[1]} млн KZT`
            
            const termMatch = historyText.match(/(\d+)\s*месяц/i) || historyText.match(/срок[:\s]*(\d+)/i)
            if (termMatch) termMonths = `${termMatch[1]} месяцев`
            
            const binMatch = historyText.match(/\b(\d{12})\b/)
            if (binMatch) bin = binMatch[1]
            
            const emailMatch = historyText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
            const phoneMatch = historyText.match(/(\+?\d[\d\s-]{9,})/g)
            const nameMatch = historyText.match(/([А-Яа-яЁё]+\s+[А-Яа-яЁё]+)/i)
            
            if (emailMatch || phoneMatch || nameMatch) {
              contacts = [
                nameMatch ? nameMatch[1] : '',
                emailMatch ? emailMatch[1] : '',
                phoneMatch ? phoneMatch[phoneMatch.length - 1] : ''
              ].filter(Boolean).join(', ')
            }
            
            // Ищем цель в сообщениях
            const purposeKeywords = ['новый бизнес', 'расширение', 'оборотные средства', 'инвестиции']
            for (const keyword of purposeKeywords) {
              if (historyText.toLowerCase().includes(keyword)) {
                purpose = keyword
                break
              }
            }
            
            // Формируем компактный запрос
            const reportRequest = `Создай подробный финансовый отчет на основе предоставленных банковских выписок.

ДАННЫЕ ЗАЯВКИ:
- Компания (БИН): ${bin}
- Запрашиваемая сумма: ${amount}
- Срок: ${termMonths}
- Цель финансирования: ${purpose}
- Контакты: ${contacts}

ЗАДАЧА:
Проанализируй все ${allFiles.length} банковские выписки (файлы уже прикреплены) и создай полный финансовый отчет по структуре из твоих инструкций.`
            
            console.log(`📝 Запрос к агенту:`)
            console.log(reportRequest)
            console.log(`\n⏱️ Запускаем Financial Analyst Agent...`)
            
            const reportRunner = new Runner({})
            const startAnalysis = Date.now()
            
            // Добавляем таймаут на 300 секунд (5 минут) для анализа всех файлов
            const analysisTimeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Financial Analyst timeout (300s)')), 300000)
            )
            
            const reportResult = await Promise.race([
              reportRunner.run(analystWithFiles, [
                { role: 'user', content: reportRequest }
              ]),
              analysisTimeout
            ])
            
            const analysisTime = ((Date.now() - startAnalysis) / 1000).toFixed(2)
            console.log(`⏱️ Анализ завершен за ${analysisTime}s`)
            console.log(`📦 Получено элементов: ${reportResult.newItems.length}`)
            
            // Логируем структуру ответа для отладки
            console.log(`🔍 Структура ответа:`)
            console.log(JSON.stringify(reportResult.newItems.map((item, i) => ({
              index: i,
              role: item.rawItem?.role,
              contentType: item.rawItem?.content?.[0]?.type,
              hasText: !!item.rawItem?.content?.[0]?.text,
              textLength: item.rawItem?.content?.[0]?.text?.length || 0
            })), null, 2))
            
            // Извлекаем отчет - пробуем все варианты
            let report = 'Отчет не сгенерирован'
            
            // Вариант 1: ищем последний assistant message с текстом
            for (let i = reportResult.newItems.length - 1; i >= 0; i--) {
              const item = reportResult.newItems[i]
              if (item.rawItem?.role === 'assistant') {
                console.log(`🔍 Проверяем элемент ${i}:`, {
                  role: item.rawItem.role,
                  contentLength: item.rawItem.content?.length,
                  firstContentType: item.rawItem.content?.[0]?.type,
                  hasText: !!item.rawItem.content?.[0]?.text
                })
                
                if (item.rawItem.content?.[0]?.text) {
                  report = item.rawItem.content[0].text
                  console.log(`✅ Найден отчет в элементе ${i}, длина: ${report.length} символов`)
                  break
                }
              }
            }
            
            // Вариант 2: если не нашли, пробуем через content.value
            if (report === 'Отчет не сгенерирован') {
              console.log(`⚠️ Вариант 1 не сработал, пробуем альтернативные пути...`)
              for (let i = reportResult.newItems.length - 1; i >= 0; i--) {
                const item = reportResult.newItems[i]
                if (item.rawItem?.role === 'assistant' && item.rawItem.content) {
                  for (const content of item.rawItem.content) {
                    if (content.type === 'text' && content.text?.value) {
                      report = content.text.value
                      console.log(`✅ Найден отчет через text.value в элементе ${i}`)
                      break
                    }
                  }
                  if (report !== 'Отчет не сгенерирован') break
                }
              }
            }
            
            // Вариант 3: если все еще не нашли, выводим полную структуру первого assistant message
            if (report === 'Отчет не сгенерирован' && reportResult.newItems.length > 0) {
              console.log(`⚠️ Вариант 2 не сработал. Полная структура первого assistant message:`)
              const assistantItem = reportResult.newItems.find(item => item.rawItem?.role === 'assistant')
              if (assistantItem) {
                console.log(JSON.stringify(assistantItem.rawItem, null, 2))
              }
            }
            
            // Сохраняем отчет
            sessionReports.set(session, {
              report,
              generated: new Date().toISOString(),
              filesCount: allFiles.length
            })
            
            console.log(`✅ Финансовый отчет сгенерирован для сессии ${session}`)
            console.log(`📊 ========== ОТЧЕТ ДЛЯ МЕНЕДЖЕРА ==========`)
            console.log(report)
            console.log(`📊 ==========================================\n`)
            
          } catch (error) {
            console.error(`❌ Ошибка генерации отчета:`, error.message)
            console.error(`❌ Стек ошибки:`, error.stack)
            
            // Получаем количество файлов из sessionFiles
            const allFiles = sessionFiles.get(session) || []
            
            // Сохраняем сообщение об ошибке как отчет
            sessionReports.set(session, {
              report: `Ошибка генерации отчета: ${error.message}`,
              generated: new Date().toISOString(),
              filesCount: allFiles.length,
              error: true
            })
          }
        })
      }
      
      return res.json({ 
        ok: true, 
        message: agentMessage,
        sessionId: session,
        completed: isFinalMessage  // Флаг для фронтенда
      })
    }

    if (classification === 'get_information') {
      console.log(`ℹ️ Запуск Information Agent...`)
      const info = await runner.run(informationAgent, [...history])
      
      // Сохраняем ответ в историю
      history.push(...info.newItems.map(item => item.rawItem))
      
      let infoMessage = 'Готово'
      for (let i = info.newItems.length - 1; i >= 0; i--) {
        const item = info.newItems[i]
        if (item.rawItem?.role === 'assistant' && item.rawItem?.content?.[0]?.text) {
          infoMessage = item.rawItem.content[0].text
          break
        }
      }
      
      console.log(`💬 Ответ Information Agent: "${infoMessage}"`)
      return res.json({ ok: true, message: infoMessage, sessionId: session })
    }

    // Для других классификаций - если у нас уже есть история, скорее всего это часть диалога
    if (history.length > 1) {
      console.log(`❓ Классификация "${classification}", но есть история - отправляем в Investment Agent`)
      
      const startTime = Date.now()
      console.log(`⏱️ Начало выполнения агента: ${new Date().toLocaleTimeString()}`)
      
      const inv = await runner.run(investmentAgent, [...history])
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2)
      console.log(`⏱️ Агент выполнен за ${duration}s`)
      console.log(`🤖 Агент вернул: ${inv.newItems.length} новых элементов`)
      
      let agentMessage = 'Продолжаем сбор данных'
      for (let i = inv.newItems.length - 1; i >= 0; i--) {
        const item = inv.newItems[i]
        if (item.rawItem?.role === 'assistant' && item.rawItem?.content?.[0]?.text) {
          agentMessage = item.rawItem.content[0].text
          break
        }
      }
      
      console.log(`💬 Ответ агента: "${agentMessage}"`)
      
      if (agentMessage.includes('=== ФИНАНСОВЫЙ АНАЛИЗ ===') || 
          agentMessage.includes('=== ИТОГОВЫЙ ОТЧЕТ ПО ЗАЯВКЕ ===')) {
        console.log(`\n📊 ========== ОТЧЕТ ДЛЯ МЕНЕДЖЕРА ==========`)
        console.log(agentMessage)
        console.log(`📊 ==========================================\n`)
      }
      
      history.push(...inv.newItems.map(item => item.rawItem))
      console.log(`💾 История обновлена: ${history.length} сообщений`)
      
      return res.json({ ok: true, message: agentMessage, sessionId: session })
    }

    console.log(`❓ Неизвестная классификация: ${classification}`)
    return res.json({ ok: true, message: 'Не понял запрос', sessionId: session })
  } catch (e) {
    console.error('agents error', e)
    return res.status(500).json({ ok: false, error: String(e) })
  }
})

// Эндпоинт для получения финансового отчета
app.get('/api/agents/report/:sessionId', (req, res) => {
  const { sessionId } = req.params
  
  console.log(`📊 Запрос отчета для сессии: ${sessionId}`)
  
  const reportData = sessionReports.get(sessionId)
  
  if (!reportData) {
    console.log(`⚠️ Отчет не найден для сессии ${sessionId}`)
    return res.json({
      ok: false,
      message: 'Отчет еще не сгенерирован. Подождите несколько секунд.'
    })
  }
  
  console.log(`✅ Отчет найден, отправляем клиенту`)
  return res.json({
    ok: true,
    report: reportData.report,
    generated: reportData.generated,
    filesCount: reportData.filesCount
  })
})

const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  console.log(`[server] agents listening on ${PORT}`)
  console.log(`[server] API key present: ${!!process.env.OPENAI_API_KEY}`)
})

// Keep server alive
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down gracefully')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[server] SIGINT received, shutting down gracefully')
  process.exit(0)
})


