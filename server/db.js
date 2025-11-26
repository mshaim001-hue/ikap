// Helper: convert `?` placeholders to PostgreSQL `$1, $2, ...`
function convertQuestionToDollar(sql) {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}

function createPostgresAdapter(connectionString) {
  // Разрешаем self-signed сертификаты ТОЛЬКО в dev
  if (process.env.NODE_ENV !== 'production') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }
  const { Pool } = require('pg')
  try {
    const masked = connectionString.replace(/:(.*?)@/, ':***@')
    const u = new URL(connectionString)
    console.log('[db] Connecting with', masked)
    console.log('[db] Parsed user:', u.username, 'host:', u.hostname, 'port:', u.port)
  } catch {}
  const pool = new Pool({
    connectionString,
    ssl: { require: true, rejectUnauthorized: false },
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000, // Начальная задержка для keep-alive (10 секунд)
    connectionTimeoutMillis: 30000, // Увеличено до 30 секунд (для Supabase pooler)
    idleTimeoutMillis: 60000, // Увеличено до 60 секунд (Supabase pooler может разрывать неактивные соединения)
    max: 5, // Максимум 5 соединений в пуле
    // Дополнительные настройки
    allowExitOnIdle: false // Не завершать процесс при отсутствии активных соединений
  })

  // Обработка ошибок пула - предотвращает краш сервера
  pool.on('error', (err, client) => {
    console.error('⚠️ Неожиданная ошибка пула PostgreSQL:', err.message)
    // Не пробрасываем ошибку - пул попытается переподключиться автоматически
  })

  // Функция для проверки, является ли ошибка временной (можно повторить запрос)
  const isRetryableError = (error) => {
    if (!error) return false
    const message = error.message || ''
    const code = error.code || ''
    
    // Ошибки разрыва соединения
    if (code === 'XX000' || 
        message.includes('db_termination') || 
        message.includes('shutdown') ||
        message.includes('connection terminated') ||
        message.includes('server closed the connection') ||
        message.includes('Connection terminated unexpectedly')) {
      return true
    }
    
    // Ошибки таймаута
    if (code === 'ETIMEDOUT' || message.includes('timeout')) {
      return true
    }
    
    // Ошибки соединения
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
      return true
    }
    
    return false
  }

  // Функция задержки с экспоненциальной задержкой
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  const query = async (text, params = [], retries = 3) => {
    let lastError = null
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await pool.query(text, params)
        // Если это был retry, логируем успех
        if (attempt > 0) {
          console.log(`✅ Запрос к БД успешен после ${attempt} попыток`)
        }
        return res
      } catch (error) {
        lastError = error
        
        // Логируем ошибку
        if (error.code === 'XX000' || error.message?.includes('db_termination') || error.message?.includes('shutdown')) {
          console.error(`⚠️ Ошибка запроса к БД (разрыв соединения): ${error.message}`)
        }
        
        // Проверяем, можно ли повторить запрос
        const isRetryable = isRetryableError(error)
        
        if (isRetryable && attempt < retries) {
          // Экспоненциальная задержка: 100ms, 200ms, 400ms
          const delayMs = 100 * Math.pow(2, attempt)
          console.log(`🔄 Повтор запроса к БД (попытка ${attempt + 1}/${retries + 1}) через ${delayMs}ms...`)
          await delay(delayMs)
          continue // Пробуем снова
        }
        
        // Если это не retryable ошибка или закончились попытки - пробрасываем
        throw error
      }
    }
    
    // Если дошли сюда - все попытки исчерпаны
    throw lastError || new Error('Неизвестная ошибка запроса к БД')
  }

  return {
    type: 'pg',
    async exec(sql) {
      // Run multiple statements separated by ';'
      const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        await query(stmt)
      }
    },
    prepare(sql) {
      const converted = convertQuestionToDollar(sql)
      return {
        async run(...params) {
          const result = await query(converted, params)
          return { changes: result.rowCount || 0 }
        },
        all(...params) {
          return query(converted, params).then(r => r.rows)
        },
        get(...params) {
          return query(converted, params).then(r => r.rows[0])
        }
      }
    }
  }
}
function createDb() {
  const url = process.env.DATABASE_URL
  if (!url || !url.startsWith('postgres')) {
    throw new Error('DATABASE_URL is required and must be a PostgreSQL URL')
  }
  console.log('[db] Using PostgreSQL')
  return createPostgresAdapter(url)
}

module.exports = {
  createDb
}


