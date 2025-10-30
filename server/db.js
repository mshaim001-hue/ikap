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
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    max: 5
  })

  const query = async (text, params = []) => {
    const res = await pool.query(text, params)
    return res
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


