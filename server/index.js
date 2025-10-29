const express = require('express')
const cors = require('cors')
const multer = require('multer')
const OpenAI = require('openai')
const { Pool } = require('pg')
const dns = require('dns')
// Предпочитать IPv4 при резолве (Node >= 18)
try { dns.setDefaultResultOrder('ipv4first') } catch (_) {}
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

// Глобальный OpenAI клиент для Assistants API
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Инициализация пула Postgres через Supabase Connection Pooling
const buildPool = () => {
  const url = new URL(process.env.DATABASE_URL)
  
  // Если это уже pooler URL, используем как есть
  if (url.hostname.includes('pooler') || url.port === '6543') {
    console.log('[db] Using Supabase Connection Pooling (PgBouncer)')
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      keepAlive: true
    })
  }
  
  // Правильный формат pooler для Supabase
  const poolerHost = url.hostname.replace('db.', '').replace('.supabase.co', '.pooler.supabase.com')
  const poolerUrl = `postgresql://${url.username}:${url.password}@${poolerHost}:6543${url.pathname}?pgbouncer=true&connection_limit=1&sslmode=require`
  
  console.log('[db] Converting to Supabase Connection Pooling URL')
  console.log(`[db] Pooler host: ${poolerHost}`)
  console.log(`[db] Pooler URL: ${poolerUrl}`)
  
  return new Pool({
    connectionString: poolerUrl,
    ssl: { rejectUnauthorized: false },
    keepAlive: true
  })
}

let pool
// создаем пул сразу (больше не нужно ждать DNS)
pool = buildPool()

const initDb = async (retries = 3) => {
  if (!pool) pool = buildPool()
  
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS reports (
          id SERIAL PRIMARY KEY,
          session_id TEXT UNIQUE NOT NULL,
          company_bin TEXT,
          amount TEXT,
          term TEXT,
          purpose TEXT,
          name TEXT,
          email TEXT,
          phone TEXT,
          report_text TEXT,
          status TEXT DEFAULT 'generating',
          files_count INTEGER DEFAULT 0,
          files_data TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          content_type TEXT DEFAULT 'text',
          message_order INTEGER NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS files (
          id SERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          file_id TEXT NOT NULL,
          original_name TEXT NOT NULL,
          file_size INTEGER,
          mime_type TEXT,
          uploaded_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
        CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
      `)
      console.log('✅ Postgres initialized with all tables')
      return
    } catch (error) {
      console.error(`❌ Postgres init attempt ${i + 1}/${retries} failed:`, error.message)
      
      // Если это ошибка DNS для pooler, попробуем оригинальный URL
      if (error.code === 'ENOTFOUND' && i === 0) {
        console.log('[db] Pooler failed, trying original URL with IPv4 forcing...')
        pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false },
          keepAlive: true,
          lookup: (hostname, options, callback) => {
            return dns.lookup(hostname, { ...options, family: 4, all: false }, callback)
          }
        })
        continue
      }
      
      if (i === retries - 1) throw error
      console.log(`⏳ Retrying in 2 seconds...`)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
}

initDb().catch((e) => {
  console.error('❌ Failed to initialize Postgres after all retries', e)
  process.exit(1)
})

// Вспомогательные функции для работы с БД (Postgres)
const saveMessageToDB = async (sessionId, role, content, messageOrder) => {
  try {
    await pool.query(
      `INSERT INTO messages (session_id, role, content, message_order) VALUES ($1, $2, $3, $4)`,
      [sessionId, role, JSON.stringify(content), messageOrder]
    )
    console.log(`💾 Сообщение сохранено в БД: ${role} #${messageOrder}`)
  } catch (error) {
    console.error(`❌ Ошибка сохранения сообщения в БД:`, error)
  }
}

const saveFileToDB = async (sessionId, fileId, originalName, fileSize, mimeType) => {
  try {
    await pool.query(
      `INSERT INTO files (session_id, file_id, original_name, file_size, mime_type) VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, fileId, originalName, fileSize, mimeType]
    )
    console.log(`📎 Файл сохранен в БД: ${originalName}`)
  } catch (error) {
    console.error(`❌ Ошибка сохранения файла в БД:`, error)
  }
}

const getMessagesFromDB = async (sessionId) => {
  try {
    const { rows } = await pool.query(
      `SELECT role, content, message_order FROM messages WHERE session_id = $1 ORDER BY message_order ASC`,
      [sessionId]
    )
    return rows.map(msg => ({
      role: msg.role,
      content: JSON.parse(msg.content)
    }))
  } catch (error) {
    console.error(`❌ Ошибка получения сообщений из БД:`, error)
    return []
  }
}

// Хранилище для истории диалогов (в памяти) - теперь дублируется в БД
const conversationHistory = new Map()

// Хранилище для файлов по сессиям
// Формат: session -> [{fileId: string, originalName: string, size: number}]
const sessionFiles = new Map()

// Code Interpreter без предустановленных файлов
// Файлы будут добавляться динамически
const codeInterpreter = codeInterpreterTool({
  container: { type: 'auto' }
})

const InvestmentAgentSchema = z.object({
  amount: z.number().nullable().optional(),
  term_months: z.number().nullable().optional(),
  completed: z.boolean().nullable().optional()
})

// Financial Analyst Agent для создания отчета
const financialAnalystAgent = new Agent({
  name: 'Financial Analyst',
  instructions: `Ты финансовый аналитик iKapitalist. Твоя ГЛАВНАЯ ЦЕЛЬ - получить чистую выручку от реализации товаров и услуг за последние 12 месяцев, с учётом всех валютных счетов, и убедиться, соответствует ли компания требованиям платформы (оборот менее 60 млн тенге за 12 месяцев).

📊 **РЕЗЮМЕ ЗАЯВКИ**
- Компания: [БИН]
- Запрашиваемая сумма: [сумма] KZT
- Срок: [месяцев]
- Цель: [цель финансирования]
- Контакты: [имя, фамилия, email, телефон]

🎯 **ОСНОВНЫЕ НАПРАВЛЕНИЯ РАБОТЫ**

1. 💰 **ВЫЯВЛЕНИЕ ОБОРОТОВ ПО РЕАЛИЗАЦИИ**
   Цель: Определить реальные поступления от продажи товаров и услуг.
   
   Что нужно сделать:
   - Из всех банковских выписок (тенговых, долларовых, рублёвых, евро-счетов) выделить операции, которые являются оплатой от клиентов за товары или услуги
   - Убедиться, что эти операции — реальная выручка, а не внутренние переводы или кредиты
   - Идентифицировать операции по реализации по характерным признакам (назначение платежа, контрагенты, регулярность)

2. 🚫 **ИСКЛЮЧЕНИЕ НЕРЕЛЕВАНТНЫХ ОПЕРАЦИЙ**
   Цель: Очистить данные, чтобы осталась только "чистая реализация".
   
   Убрать:
   - Возвраты товаров и услуг (обратные платежи клиентам)
   - Займы, кредиты, пополнения, переводы между своими счетами
   - Ошибочные зачисления
   - Любые поступления, не связанные с продажей
   - Внутренние переводы между счетами компании

3. 💱 **УЧЁТ ВАЛЮТНЫХ СЧЕТОВ**
   Цель: Корректно включить валютную выручку в общую сумму.
   
   Что нужно сделать:
   - По каждому валютному счёту определить поступления (USD, EUR, RUB и т.д.)
   - Конвертировать поступления в тенге по курсу на дату поступления (курс можно брать из данных банка или официального НБ РК)
   - НЕ учитывать внутренние переводы между валютными и тенговыми счетами (чтобы не задвоить выручку)
   - Если часть валюты отправляется поставщику напрямую — эти суммы не считать выручкой (так как они не доходят до компании в тенге)

4. 📅 **ГРУППИРОВКА ПО МЕСЯЦАМ**
   Цель: Посмотреть динамику продаж во времени.
   
   Что нужно сделать:
   - ПРОАНАЛИЗИРУЙ ВСЕ выписки: они могут быть как от одного так и от нескольких казахстанских банков.
   - ОБЪЕДИНИ данные из всех выписок для создания непрерывного периода за последние 12 месяцев
   - Сгруппировать чистые поступления (в пересчёте в тенге) по месяцам за последние 12 месяцев
   - Рассчитать итоговую сумму реализации за период
   - Создать таблицу динамики по месяцам
   - ВАЖНО: Убедись, что ты используешь данные за 12 месяцев, даже если они из разных выписок

5. 📈 **ФОРМИРОВАНИЕ СВОДНОГО АНАЛИЗА**
   Цель: Подготовить понятный итог для отчёта или проверки.
   
   Что нужно сделать:
   - Сделать сводную таблицу с колонками:
     * Месяц
     * Реализация (тенге + валютные счета в пересчёте)
     * Возвраты
     * Чистая реализация
   - По желанию добавить график (динамика по месяцам)

6. ⚖️ **СРАВНЕНИЕ С ТРЕБОВАНИЯМИ ПЛАТФОРМЫ**
   Цель: Проверить соответствие лимиту.
   
   Что нужно сделать:
   - Сравнить общую чистую реализацию за 12 месяцев с порогом 60 млн тенге
   - Если меньше — компания НЕ соответствует требованиям платформы
   - Если больше или равна — компания соответствует требованиям

📋 **СТРУКТУРА ОТЧЕТА**

**АНАЛИЗ ПО БАНКАМ:**
Для каждого банка:
- Название банка и период(ы) выписки
- Выявленные операции по реализации (сумма в тенге)
- Исключённые операции (с обоснованием)
- Чистая выручка по банку (с учётом всех выписок этого банка)

**СВОДНЫЙ АНАЛИЗ:**
- Общая чистая выручка за 12 месяцев: [сумма] KZT
- Динамика по месяцам (таблица)
- Соответствие требованиям платформы: ✅/❌

**РЕКОМЕНДАЦИЯ:**
- ✅ СООТВЕТСТВУЕТ требованиям (выручка ≥ 60 млн KZT)
- ❌ НЕ СООТВЕТСТВУЕТ требованиям (выручка < 60 млн KZT)

---

ВАЖНО:
- Используй Code Interpreter для анализа всех файлов
- Все суммы указывай в KZT с разделителями тысяч
- Будь точным с датами и периодами
- При объединении данных из разных выписок убедись, что нет дублирования операций
- Проверь, что покрыты полные 12 месяцев (может потребоваться использовать данные из разных выписок)
- Выдели ключевые моменты жирным шрифтом
- Используй эмодзи для визуальной структуры
- ФОКУСИРУЙСЯ на чистой выручке от реализации, а не на общих оборотах`,
  model: 'gpt-5',
  tools: [codeInterpreter],
  modelSettings: { store: true }
})

const investmentAgent = new Agent({
  name: 'Investment Agent',
  instructions: `Ты помощник регистрации инвестиций для iKapitalist. Собирай данные пошагово, задавай один вопрос за раз.

ВАЖНО: ПЕРЕД каждым ответом анализируй историю диалога, чтобы понять:
- На каком этапе находится диалог
- Какие данные уже собраны
- Какой следующий вопрос нужно задать

ЭТАПЫ СБОРА ДАННЫХ (после принятия условий):
1. "Какую сумму Вы хотите получить?" - получи сумму и убедись  что сумма между мин 10 миллионов- макс 1 миллиярд тенге
2. "На какой срок?" (в месяцах) - получи срок и убедись что срок между 4 и 36 месяцев
3. "Для чего Вы привлекаете финансирование?" - получи цель
4. "Пожалуйста, предоставьте Ваш БИН" - получи БИН и убедись что БИН состоит из 12 цифр
5. "Пожалуйста, прикрепите выписку с банка от юр лица за 12 месяцев" - получи выписки
6. После получения выписки - запроси выписки других банков за тот же период(повторяй до получения "нет")
7. "Пожалуйста, оставьте Ваши контактные данные: имя, фамилию, email и телефон" - получи контакты и убедись что номер принадлежит какому либо из Казахстана и состоит из 11 цифр
8. После получения контактов - отправь финальное сообщение

ПРАВИЛА АНАЛИЗА ИСТОРИИ:
- Если в истории уже есть сумма (например, "90 мил", "90 млн") - НЕ спрашивай сумму снова
- Если в истории уже есть срок (например, "12 месяцев") - НЕ спрашивай срок снова
- Если в истории уже есть цель (например, "новый бизнес") - НЕ спрашивай цель снова
- Если в истории уже есть БИН (например, "100740014947") - НЕ спрашивай БИН снова
- Если пользователь говорит "ты же уже спрашивал" - переходи к следующему этапу

АНАЛИЗ БАНКОВСКИХ ВЫПИСОК:

ОБЯЗАТЕЛЬНАЯ ПОСЛЕДОВАТЕЛЬНОСТЬ:
1. Собрать выписки за 12 месяцев 
2. Спросить про другие банки за тот же период
3. Повторять пункт 2 до получения "нет"
4. Только после "нет" → переходить к контактным данным

Когда пользователь прикрепляет файл:

1. АНАЛИЗИРУЙ файл через Code Interpreter:
   - Извлеки период выписки (даты начала и конца)
   - Определи, какая дата начала (год и месяц)
   - Проверь, достаточно ли данных (12 месяцев покрытия)
   - Проверь, это банковская выписка или нет

2. ПРОВЕРКА ПЕРИОДА:
   Нужна выписка за 12 месяцев
   
   ВАЖНО: Проверь начало периода выписки и покрытие полных 12 месяцев!
   
   КРИТИЧЕСКИ ВАЖНО: После анализа файла через Code Interpreter:
   1. Определи дату начала выписки (например, 1.1.2025) и дату конца выписки (например, 31.1.2025 или текущая дата)
   2. Вычисли разницу в месяцах между датой начала и датой конца выписки
   3. Если период выписки составляет МЕНЕЕ 12 месяцев:
         ОБЯЗАТЕЛЬНО СПРОСИ: "Для полного анализа нам нужны данные за полные 12 месяцев. Ваша выписка охватывает период с [день.месяц.год] по [день.месяц.год] ([X] месяцев). Пожалуйста, прикрепите выписку за за 12 месяцев."

         НЕ ПЕРЕХОДИ к вопросам про другие банки, пока не получишь выписку за полные 12 месяцев данных!
   
   Если получена выписка за полные 12 месяцев:
      "Выписка принята. Есть ли у вас счета в других банках? Если да, прикрепите выписки за тот же период, что первая выписка. Если нет, напишите 'нет'."
   
   ПОСЛЕ получения второй выписки другого банка за тот же период, что первая выписка:
      Проверь через Code Interpreter, покрывают ли выписка полные 12 месяцев
      - Если ДА: "Выписка принята. Есть ли у вас счета в других банках? Если да, прикрепите выписки за 12 месяцев. Если нет, напишите 'нет'."
      - Если НЕТ: попроси выписку за полные 12 месяцев, за тот период что первая выписка
   
   ПОСЛЕ каждой новой выписки от другого банка:
      Проверь период этой выписки через Code Interpreter (так же, как для первой выписки):
      - Если выписка покрывает Не попадает в тот же период что первая выписка - попроси выписку за тот же период, что первая выписка, для этого банка
      - Если выписка покрывает тот же период что первая выписка - спроси про другие банки
      ОБЯЗАТЕЛЬНО СПРОСИ: "Есть ли у вас еще счета в других банках? Если да, прикрепите выписки. Если нет, напишите 'нет'."
   
   ТОЛЬКО ПОСЛЕ "нет" про другие банки:
      "Спасибо за предоставленные банковские выписки! Пожалуйста, оставьте ваши контактные данные: имя, фамилию, email и телефон."
      
   ВАЖНО: НЕ ПЕРЕХОДИ к контактам БЕЗ явного "нет"!

КРИТИЧЕСКИЕ СЛУЧАИ:
Если клиент отказывается предоставить выписку за 12 месяцев ("нет под рукой", "не могу предоставить" и т.п.):
   Сказать: "Для рассмотрения заявки необходимы выписка за 12 месяцев. Пожалуйста, соберите все документы и подайте заявку заново. Диалог завершен."
   ЗАКРЫТЬ диалог.

КОНТАКТНЫЕ ДАННЫЕ:
Когда пользователь ответил "нет" про другие банки:
   "Спасибо за предоставленные банковские выписки! Пожалуйста, оставьте ваши контактные данные: имя, фамилию, email и телефон."

ФИНАЛЬНОЕ СООБЩЕНИЕ:
Когда пользователь предоставил все контактные данные:
   "Спасибо за предоставленную информацию! Ваша заявка принята на рассмотрение. Мы проанализируем предоставленные документы и свяжемся с вами. Ожидайте уведомления от платформы iKapitalist."
   
   СОХРАНИ в историю отчёт для менеджера: сумма, срок, цель, БИН, выписки, контакты.

ВАЖНО: 
- Задавай один вопрос за раз, не повторяй предыдущие.
- Отвечай простыми вопросами, без технических данных.
- Клиенту говори только "Выписка принята" + следующий запрос.
- Детальный анализ делай внутренне для отчета менеджеру.

ПРИМЕРЫ АНАЛИЗА ИСТОРИИ:
- Если пользователь написал "100740014947" - это БИН, переходи к следующему этапу
- Если пользователь написал "90 мил" - это сумма, переходи к следующему этапу  
- Если пользователь написал "12" - это срок, переходи к следующему этапу
- Если пользователь написал "новый бизнес" - это цель, переходи к следующему этапу
- Если пользователь говорит "ты же уже спрашивал" - найди следующий недостающий этап

АЛГОРИТМ РАБОТЫ:
1. Проанализируй всю историю диалога
2. Определи, какие данные уже собраны (сумма, срок, цель, БИН, выписки, контакты)
3. Найди первый недостающий этап
4. Задай только один вопрос по этому этапу
5. НЕ повторяй уже собранные данные`,
  model: 'gpt-5-mini',
  tools: [codeInterpreter],
  modelSettings: { store: true }
})

const informationAgent = new Agent({
  name: 'Information Agent',
  instructions: 'Отвечай на вопросы о процессе привлечения инвестиций.',
  model: 'gpt-5',
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
      // Пытаемся восстановить историю из БД
      const dbMessages = await getMessagesFromDB(session)
      if (dbMessages.length > 0) {
        conversationHistory.set(session, dbMessages)
        console.log(`🔄 История восстановлена из БД: ${dbMessages.length} сообщений`)
      } else {
        conversationHistory.set(session, [])
        console.log(`🆕 Создана новая сессия`)
      }
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
        
        // Сохраняем файл в sessionFiles для последующего анализа
        if (!sessionFiles.has(session)) {
          sessionFiles.set(session, [])
        }
        sessionFiles.get(session).push({
          fileId: uploadedFileId,
          originalName: file.originalname,
          size: file.size,
          uploadedAt: new Date().toISOString()
        })
        console.log(`💾 Файл сохранен в сессии. Всего файлов: ${sessionFiles.get(session).length}`)
        
        // Сохраняем метаданные файла в БД
        await saveFileToDB(session, uploadedFileId, file.originalname, file.size, file.mimetype)
        
        // Добавляем информацию о файле в текст
        // Code Interpreter автоматически получит доступ к файлу через file_id в контейнере
        messageContent[0].text += `\n\n[Прикреплен файл ID: ${uploadedFileId}, название: ${file.originalname}]`
      } catch (error) {
        console.error(`❌ Ошибка загрузки файла:`, error)
        messageContent[0].text += `\n\n[Не удалось загрузить файл: ${file.originalname}]`
      }
    }
    
    // Добавляем новое сообщение пользователя
    const userMessage = { role: 'user', content: messageContent }
    history.push(userMessage)
    
    // Сохраняем сообщение пользователя в БД
    const messageOrder = history.length
    await saveMessageToDB(session, 'user', messageContent, messageOrder)
    
    const runner = new Runner({})

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
      
      // Запускаем агента с увеличенным таймаутом (120 секунд для анализа файлов)
      // Передаем всю историю - не можем обрезать из-за reasoning items в gpt-5
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Agent timeout (120s)')), 120000)
      )
      
      let inv
      try {
        inv = await Promise.race([
          runner.run(agentToRun, [...history]),
          timeoutPromise
        ])
      } catch (error) {
        if (error.message.includes('timeout')) {
          console.error('⏰ Агент превысил таймаут 120 секунд')
          // Возвращаем ok: true чтобы разблокировать фронтенд
          return res.json({
            ok: true,
            message: 'Анализ файла занял слишком много времени. Пожалуйста, продолжите: напишите "да" если файл загружен, или прикрепите другой файл.',
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
      const newItems = inv.newItems.map(item => item.rawItem)
      history.push(...newItems)
      console.log(`💾 История обновлена: ${history.length} сообщений`)
      
      // Сохраняем новые сообщения агента в БД
      for (let index = 0; index < newItems.length; index++) {
        const item = newItems[index]
        const messageOrder = history.length - newItems.length + index + 1
        await saveMessageToDB(session, item.role, item.content, messageOrder)
      }
      
      // Проверяем, это финальное сообщение (заявка завершена)
      const isFinalMessage = agentMessage.includes('Ваша заявка принята на рассмотрение') || 
                            agentMessage.includes('Ожидайте уведомления от платформы iKapitalist')
      
      if (isFinalMessage) {
        console.log(`✅ Заявка завершена! Генерируем финансовый отчет...`)
        
        // Генерируем отчет асинхронно (не блокируем ответ клиенту)
        setImmediate(async () => {
          // Определяем allFiles в начале для доступа в catch блоке
          let allFiles = []
          
          try {
            // Получаем файлы из БД вместо памяти
            const { rows: dbFiles } = await pool.query(
              `SELECT file_id, original_name, file_size, mime_type, uploaded_at FROM files WHERE session_id = $1 ORDER BY uploaded_at ASC`,
              [session]
            )
            
            // Преобразуем в формат, совместимый со старым кодом
            allFiles = dbFiles.map(f => ({
              fileId: f.file_id,
              originalName: f.original_name,
              size: f.file_size,
              uploadedAt: f.uploaded_at
            }))
            
            if (allFiles.length === 0) {
              console.log(`⚠️ Нет файлов для анализа в БД`)
              return
            }
            
            console.log(`📊 Генерация отчета с ${allFiles.length} файлами...`)
            console.log(`📎 Файлы для анализа:`, allFiles)
            
            // Извлекаем только fileId для передачи в агента
            const fileIds = allFiles.map(f => f.fileId)
            
            // Извлекаем ключевую информацию из истории (без передачи всех сообщений)
            let amount = 'не указана'
            let termMonths = 'не указан'
            let purpose = 'не указана'
            let bin = 'не указан'
            let name = 'не указано'
            let email = 'не указан'
            let phone = 'не указан'
            
            // Парсим историю для извлечения данных
            const historyText = history.map(msg => {
              if (typeof msg.content === 'string') return msg.content
              if (Array.isArray(msg.content)) return msg.content.map(c => c.text || '').join(' ')
              return ''
            }).join(' ')
            
            // Извлечение данных из истории сообщений
            const amountMatch = historyText.match(/(\d+)\s*мил/i)
            if (amountMatch) amount = `${amountMatch[1]} млн KZT`
            
            // Ищем срок - сначала в последовательности вопрос-ответ
            for (let i = 0; i < history.length; i++) {
              const msg = history[i]
              if (msg.role === 'assistant') {
                const assistantText = typeof msg.content === 'string' 
                  ? msg.content 
                  : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : '')
                
                // Если агент спрашивает о сроке
                if (assistantText.match(/срок|месяц/i)) {
                  // Берем следующее сообщение пользователя
                  if (i + 1 < history.length && history[i + 1].role === 'user') {
                    const userResponse = typeof history[i + 1].content === 'string'
                      ? history[i + 1].content
                      : (Array.isArray(history[i + 1].content) ? history[i + 1].content.map(c => c.text || '').join(' ') : '')
                    
                    // Ищем число в ответе пользователя
                    const numberMatch = userResponse.match(/(\d+)/)
                    if (numberMatch) {
                      termMonths = `${numberMatch[1]} месяцев`
                      break
                    }
                  }
                }
              }
            }
            
            // Если не нашли в последовательности, пробуем по ключевым словам
            if (termMonths === 'не указан') {
              const termMatch = historyText.match(/(\d+)\s*месяц/i) || 
                               historyText.match(/срок[:\s]*(\d+)/i) ||
                               historyText.match(/(\d+)\s*мес/i) ||
                               historyText.match(/срок[^0-9]*(\d+)/i)
              if (termMatch) termMonths = `${termMatch[1]} месяцев`
            }
            
            const binMatch = historyText.match(/\b(\d{12})\b/)
            if (binMatch) bin = binMatch[1]
            
            // Ищем цель финансирования в истории
            // Сначала пытаемся найти в последовательности сообщений
            for (let i = 0; i < history.length; i++) {
              const msg = history[i]
              if (msg.role === 'assistant') {
                const assistantText = typeof msg.content === 'string' 
                  ? msg.content 
                  : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : '')
                
                // Если агент спрашивает о цели
                if (assistantText.match(/для чего|цел[ьи]|привлекаете финансирование/i)) {
                  // Берем следующее сообщение пользователя
                  if (i + 1 < history.length && history[i + 1].role === 'user') {
                    const userResponse = typeof history[i + 1].content === 'string'
                      ? history[i + 1].content
                      : (Array.isArray(history[i + 1].content) ? history[i + 1].content.map(c => c.text || '').join(' ') : '')
                    
                    // Очищаем от служебной информации о файлах и датах
                    purpose = userResponse
                      .replace(/\[Прикреплен файл.*?\]/g, '')
                      .replace(/\[ДАТА:.*?\]/g, '')
                      .replace(/^\s*\[.*?\]\s*/g, '') // Убираем любые [скобки] в начале
                      .trim()
                    if (purpose) break
                  }
                }
              }
            }
            
            // Если не нашли, пробуем по ключевым словам
            if (purpose === 'не указана') {
              const purposeKeywords = ['новый бизнес', 'расширение', 'оборотные средства', 'инвестиции', 'пополнение']
              for (const keyword of purposeKeywords) {
                if (historyText.toLowerCase().includes(keyword)) {
                  purpose = keyword
                  break
                }
              }
            }
            
            // Извлекаем контакты из ПОСЛЕДНЕГО сообщения пользователя
            const lastUserMessage = [...history].reverse().find(msg => msg.role === 'user')
            if (lastUserMessage) {
              const contactText = typeof lastUserMessage.content === 'string' 
                ? lastUserMessage.content 
                : (Array.isArray(lastUserMessage.content) 
                  ? lastUserMessage.content.map(c => c.text || '').join(' ') 
                  : '')
              
              const emailMatch = contactText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
              if (emailMatch) email = emailMatch[1]
              
              const phoneMatch = contactText.match(/(\+?\d[\d\s-]{9,})/g)
              if (phoneMatch) phone = phoneMatch[phoneMatch.length - 1]
              
              const nameMatch = contactText.match(/([А-Яа-яЁё]+\s+[А-Яа-яЁё]+)/i)
              if (nameMatch) name = nameMatch[1]
            }
            
            // Сохраняем заявку в БД со статусом "generating"
            const filesData = JSON.stringify(allFiles)
            await pool.query(
              `INSERT INTO reports (session_id, company_bin, amount, term, purpose, name, email, phone, files_count, files_data, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'generating')
               ON CONFLICT (session_id) DO UPDATE SET company_bin=EXCLUDED.company_bin, amount=EXCLUDED.amount, term=EXCLUDED.term, purpose=EXCLUDED.purpose, name=EXCLUDED.name, email=EXCLUDED.email, phone=EXCLUDED.phone, files_count=EXCLUDED.files_count, files_data=EXCLUDED.files_data, status='generating'`,
              [session, bin, amount, termMonths, purpose, name, email, phone, allFiles.length, filesData]
            )
            console.log(`💾 Заявка сохранена в БД: ${session}, файлов: ${allFiles.length}`)
            
            // Формируем компактный запрос
            const reportRequest = `Создай подробный финансовый отчет на основе предоставленных банковских выписок.

ДАННЫЕ ЗАЯВКИ:
- Компания (БИН): ${bin}
- Запрашиваемая сумма: ${amount}
- Срок: ${termMonths}
- Цель финансирования: ${purpose}
- Контакты: ${name}, ${email}, ${phone}

ЗАДАЧА:
Проанализируй все ${allFiles.length} банковские выписки (файлы уже прикреплены) и создай финансовый отчет по структуре из твоих инструкций.`
            
            console.log(`📝 Запрос к агенту:`)
            console.log(reportRequest)
            console.log(`\n⏱️ Запускаем Financial Analyst Agent...`)
            
            const startAnalysis = Date.now()
            
            // Добавляем таймаут на 30 минут для анализа всех файлов (PDF анализ может быть долгим)
            const TIMEOUT_MS = 30 * 60 * 1000 // 30 минут
            const analysisTimeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Financial Analyst timeout (${TIMEOUT_MS/1000}s)`)), TIMEOUT_MS)
            )
            
            // Функция для периодического логирования прогресса
            const startProgressLogger = () => {
              let elapsed = 0
              const intervalId = setInterval(() => {
                elapsed += 60
                console.log(`⏰ Генерация отчета: прошло ${elapsed} секунд...`)
              }, 60000) // Каждую минуту
              
              return () => clearInterval(intervalId)
            }
            
            // Функция для запуска Financial Analyst Agent через Agents SDK
            const runWithAgentSDK = async () => {
              console.log(`🚀 Запускаем Financial Analyst Agent через Agents SDK...`)
              
              // Создаем агента с доступом ко всем файлам
              const analystWithFiles = new Agent({
                ...financialAnalystAgent,
                tools: [codeInterpreterTool({ 
                  container: { 
                    type: 'auto', 
                    file_ids: fileIds 
                  } 
                })]
              })
              console.log(`✅ Financial Analyst Agent создан с файлами (model: ${financialAnalystAgent.model})`)
              
              // Создаем Runner
              const reportRunner = new Runner({})
              
              // Запускаем агента с таймаутом
              const stopLogger = startProgressLogger()
              
              console.log(`⚙️ Запускаем агента с запросом: "${reportRequest.substring(0, 100)}..."`)
              
              try {
                // Запускаем агента с одним сообщением пользователя
                const result = await reportRunner.run(analystWithFiles, [{
                  role: 'user',
                  content: [{ type: 'input_text', text: reportRequest }]
                }])
                
                stopLogger()
                console.log(`✅ Agent completed! Получено ${result.newItems.length} новых элементов`)
                
                return result
              } catch (error) {
                stopLogger()
                throw error
              }
            }
            
            console.log(`⏳ Ожидание ответа от Financial Analyst Agent...`)
            console.log(`🔄 Начинаем runWithAgentSDK через Agents SDK...`)
            
            // Запускаем с таймаутом
            const reportResult = await Promise.race([
              runWithAgentSDK(),
              analysisTimeout
            ])
            
            console.log(`✅ Financial Analyst Agent завершен успешно`)
            const analysisTime = ((Date.now() - startAnalysis) / 1000).toFixed(2)
            console.log(`⏱️ Анализ завершен за ${analysisTime}s`)
            console.log(`📦 Получено элементов: ${reportResult.newItems.length}`)
            console.log(`✅ Отчет успешно получен от OpenAI`)
            
            // Логируем структуру ответа для отладки
            console.log(`🔍 Структура ответа (newItems: ${reportResult.newItems?.length || 0}):`)
            
            // Детальное логирование каждого элемента
            reportResult.newItems?.forEach((item, i) => {
              console.log(`\n📦 Элемент ${i}:`)
              console.log(`  - role: ${item.rawItem?.role}`)
              console.log(`  - content type: ${Array.isArray(item.rawItem?.content) ? 'array' : typeof item.rawItem?.content}`)
              
              if (Array.isArray(item.rawItem?.content)) {
                item.rawItem.content.forEach((c, ci) => {
                  console.log(`  - content[${ci}].type: ${c?.type}`)
                  if (c?.type === 'text') {
                    console.log(`  - content[${ci}].text length: ${c?.text?.length || 0}`)
                    if (c?.text && typeof c.text === 'string') {
                      console.log(`  - content[${ci}].text preview: ${c.text.substring(0, 100)}...`)
                    } else if (c?.text && typeof c.text === 'object') {
                      console.log(`  - content[${ci}].text is object: ${JSON.stringify(c.text).substring(0, 100)}...`)
                    } else {
                      console.log(`  - content[${ci}].text type: ${typeof c.text}`)
                    }
                  }
                })
              } else if (typeof item.rawItem?.content === 'string') {
                console.log(`  - content (string) length: ${item.rawItem.content.length}`)
                console.log(`  - content preview: ${item.rawItem.content.substring(0, 100)}...`)
              }
            })
            
            // Извлекаем отчет - пробуем все варианты
            let report = null
            
            // Вариант 1: ищем последний assistant message с текстом
            for (let i = reportResult.newItems.length - 1; i >= 0; i--) {
              const item = reportResult.newItems[i]
              if (item.rawItem?.role === 'assistant') {
                console.log(`\n🔍 Проверяем элемент ${i} (assistant):`)
                
                // Проверяем разные форматы content
                if (Array.isArray(item.rawItem.content)) {
                  // content - массив объектов
                  for (const contentItem of item.rawItem.content) {
                    if (contentItem?.type === 'text' && contentItem?.text) {
                      if (typeof contentItem.text === 'string') {
                        report = contentItem.text
                        console.log(`✅ Найден отчет (text type) в элементе ${i}, длина: ${report.length} символов`)
                        break
                      } else if (typeof contentItem.text === 'object' && contentItem.text.value) {
                        report = contentItem.text.value
                        console.log(`✅ Найден отчет (text.value) в элементе ${i}, длина: ${report.length} символов`)
                        break
                      } else {
                        console.log(`⚠️ contentItem.text не является строкой: ${typeof contentItem.text}`)
                      }
                    }
                  }
                } else if (typeof item.rawItem.content === 'string') {
                  // content - строка
                  report = item.rawItem.content
                  console.log(`✅ Найден отчет (string) в элементе ${i}, длина: ${report.length} символов`)
                }
                
                if (report) break
              }
            }
            
            // Вариант 2: если не нашли, пробуем через content.value
            if (!report) {
              console.log(`⚠️ Вариант 1 не сработал, пробуем альтернативные пути (content.text.value)...`)
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
                  if (report) break
                }
              }
            }
            
            // Вариант 3: если все еще не нашли, выводим полную структуру всех assistant messages
            if (!report && reportResult.newItems.length > 0) {
              console.log(`⚠️ Вариант 2 не сработал. Полная структура всех assistant messages:`)
              reportResult.newItems.forEach((item, i) => {
                if (item.rawItem?.role === 'assistant') {
                  console.log(`\n--- Assistant message ${i} ---`)
                  console.log(JSON.stringify(item.rawItem, null, 2))
                }
              })
            }
            
            // Если все еще не нашли, устанавливаем дефолтное сообщение
            if (!report) {
              report = 'Отчет не сгенерирован - не удалось извлечь текст из ответа агента. Проверьте логи выше.'
              console.error(`❌ Не удалось извлечь отчет из ${reportResult.newItems.length} элементов`)
            }
            
            // Сохраняем отчет в БД
            console.log(`💾 Сохраняем отчет в БД...`)
            console.log(`📝 Длина отчета: ${report ? report.length : 0} символов`)
            
            const updateResult = await pool.query(
              `UPDATE reports SET report_text = $1, status = 'completed', completed_at = NOW() WHERE session_id = $2`,
              [report, session]
            )
            console.log(`💾 Отчет сохранен в БД для сессии: ${session}, изменено строк: ${updateResult.rowCount}`)
            
            // Проверяем что действительно сохранилось
            const { rows: checkRows } = await pool.query('SELECT status, LENGTH(report_text) as report_length FROM reports WHERE session_id = $1',[session])
            const checkResult = checkRows[0]
            console.log(`🔍 Проверка БД: статус=${checkResult?.status}, длина отчета=${checkResult?.report_length}`)
            
            console.log(`✅ Финансовый отчет сгенерирован и сохранен в БД для сессии ${session}`)
            console.log(`📊 ========== ОТЧЕТ ДЛЯ МЕНЕДЖЕРА ==========`)
            console.log(report.substring(0, 500) + '...')
            console.log(`📊 ==========================================\n`)
            
          } catch (error) {
            console.error(`❌ Ошибка генерации отчета:`, error.message)
            console.error(`❌ Стек ошибки:`, error.stack)
            
            // Если это таймаут — НЕ помечаем отчет как error, оставляем status=generating.
            // Агент мог продолжить выполнение в OpenAI, и отчет придет позже.
            if (String(error.message || '').includes('timeout')) {
              console.warn('⏳ Financial Analyst не успел за таймаут. Статус оставлен generating, отчет может появиться позже.')
            } else {
              // Сохраняем ошибку в БД
              await pool.query(
                `UPDATE reports SET report_text = $1, status = 'error', completed_at = NOW() WHERE session_id = $2`,
                [`Ошибка генерации отчета: ${error.message}`, session]
              )
            }
          }
        })
      }
      
      return res.json({ 
        ok: true, 
        message: agentMessage,
        sessionId: session,
        completed: isFinalMessage  // Флаг для фронтенда
      })
  } catch (e) {
    console.error('agents error', e)
    return res.status(500).json({ ok: false, error: String(e) })
  }
})

// Эндпоинт для получения финансового отчета
// Эндпоинт для получения отчета по session_id
app.get('/api/reports/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  
  console.log(`📊 Запрос отчета для сессии: ${sessionId}`)
  
  try {
    const { rows } = await pool.query('SELECT * FROM reports WHERE session_id = $1', [sessionId])
    const report = rows[0]
    
    if (!report) {
      console.log(`⚠️ Отчет не найден для сессии ${sessionId}`)
      return res.json({
        ok: false,
        message: 'Заявка не найдена'
      })
    }
    
    console.log(`✅ Отчет найден, статус: ${report.status}`)
    return res.json({
      ok: true,
      report: {
        sessionId: report.session_id,
        bin: report.company_bin,
        amount: report.amount,
        term: report.term,
        purpose: report.purpose,
        name: report.name,
        email: report.email,
        phone: report.phone,
        filesCount: report.files_count,
        status: report.status,
        reportText: report.report_text,
        createdAt: report.created_at,
        completedAt: report.completed_at
      }
    })
  } catch (error) {
    console.error('❌ Ошибка получения отчета:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера'
    })
  }
})

// Эндпоинт для восстановления истории сессии
app.get('/api/sessions/:sessionId/history', async (req, res) => {
  const { sessionId } = req.params
  console.log(`📖 Запрос истории сессии: ${sessionId}`)
  
  try {
    // Получаем историю из БД
    const history = await getMessagesFromDB(sessionId)
    
    if (!history || history.length === 0) {
      console.log(`⚠️ История не найдена в БД для сессии: ${sessionId}`)
      return res.status(404).json({
        ok: false,
        message: 'Сессия не найдена'
      })
    }
    
    // Преобразуем историю в формат сообщений для фронтенда
    const messages = []
    
    // Добавляем приветственное сообщение
    messages.push({
      id: 1,
      text: "Здравствуйте, как я могу к Вам обращаться?",
      sender: 'bot',
      timestamp: new Date()
    })
    
    // Преобразуем историю из БД
    history.forEach((item, index) => {
      if (item.role === 'user') {
        let text = ''
        if (typeof item.content === 'string') {
          text = item.content
        } else if (Array.isArray(item.content)) {
          text = item.content.map(c => c.text || '').join(' ')
        }
        
        messages.push({
          id: Date.now() + index * 2,
          text: text,
          sender: 'user',
          timestamp: new Date()
        })
      } else if (item.role === 'assistant') {
        let text = ''
        if (typeof item.content === 'string') {
          text = item.content
        } else if (Array.isArray(item.content)) {
          text = item.content.map(c => c.text || '').join(' ')
        }
        
        if (text) {
          messages.push({
            id: Date.now() + index * 2 + 1,
            text: text,
            sender: 'bot',
            timestamp: new Date()
          })
        }
      }
    })
    
    console.log(`✅ История восстановлена из БД: ${messages.length} сообщений`)
    return res.json({
      ok: true,
      messages: messages
    })
  } catch (error) {
    console.error('❌ Ошибка восстановления истории:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера'
    })
  }
})

// Эндпоинт для получения файлов сессии
app.get('/api/sessions/:sessionId/files', async (req, res) => {
  const { sessionId } = req.params
  console.log(`📎 Запрос файлов для сессии: ${sessionId}`)
  
  try {
    const { rows: files } = await pool.query(
      `SELECT file_id, original_name, file_size, mime_type, uploaded_at FROM files WHERE session_id = $1 ORDER BY uploaded_at ASC`,
      [sessionId]
    )
    
    console.log(`✅ Найдено файлов для сессии ${sessionId}: ${files.length}`)
    return res.json({
      ok: true,
      files: files.map(f => ({
        fileId: f.file_id,
        originalName: f.original_name,
        fileSize: f.file_size,
        mimeType: f.mime_type,
        uploadedAt: f.uploaded_at
      }))
    })
  } catch (error) {
    console.error('❌ Ошибка получения файлов:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера'
    })
  }
})

// Эндпоинт для получения списка всех заявок (для менеджера)
app.get('/api/reports', async (req, res) => {
  try {
    const { rows: reports } = await pool.query(
      `SELECT session_id, company_bin, amount, term, purpose, name, email, phone, status, files_count, created_at, completed_at FROM reports ORDER BY created_at DESC`
    )
    
    console.log(`📋 Получен список заявок: ${reports.length} шт.`)
    return res.json({
      ok: true,
      reports: reports.map(r => ({
        sessionId: r.session_id,
        bin: r.company_bin,
        amount: r.amount,
        term: r.term,
        purpose: r.purpose,
        name: r.name,
        email: r.email,
        phone: r.phone,
        filesCount: r.files_count,
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at
      }))
    })
  } catch (error) {
    console.error('❌ Ошибка получения списка заявок:', error)
    return res.status(500).json({
      ok: false,
      message: 'Ошибка сервера'
    })
  }
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


