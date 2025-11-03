// Helper: convert `?` placeholders to PostgreSQL `$1, $2, ...`
function convertQuestionToDollar(sql) {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}

function createPostgresAdapter(connectionString) {
  // Allow self-signed certs (Supabase pooler) during development
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
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

  const query = async (text, params = []) => {
    try {
      const res = await pool.query(text, params)
      return res
    } catch (error) {
      // Логируем ошибку для отладки, но пробрасываем дальше для обработки вызывающим кодом
      if (error.code === 'XX000' || error.message?.includes('db_termination') || error.message?.includes('shutdown')) {
        console.error('⚠️ Ошибка запроса к БД (разрыв соединения):', error.message)
      }
      throw error // Пробрасываем ошибку для обработки в вызывающем коде
    }
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
          await query(converted, params)
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


