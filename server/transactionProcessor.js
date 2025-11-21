/**
 * Модуль для обработки банковских транзакций
 * Функции для классификации, парсинга, суммирования транзакций
 */

const MONTH_NAMES_RU = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]

const REVENUE_KEYWORDS = [
  'оплата', 'за товар', 'за товары', 'за услугу', 'за услуги',
  'договор', 'invoice', 'contract', 'поставка', 'продажа', 'реализац',
  'sales', 'services', 'услуги', 'работы', 'покупатель', 'customer',
  'сф#', 'счет-фактура', 'счет фактура', 'акт оказанных', 'акт оказ',
  'акт услуг', 'зп#', 'уведомление', 'опл прочих', 'оплата прочих',
  'оплата услуг', 'оплата работ', 'kaspi', 'kaspi.kz',
  'продажи с kaspi', 'продажи с kaspi.kz',
]

const NON_REVENUE_KEYWORDS = [
  'займ', 'кредит', 'loan', 'return', 'возврат', 'возврат средств',
  'возврат денежных средств', 'возврат за непредоставленные', 'возмещение',
  'между своими', 'депозит', 'вклад', 'refund', 'инвести', 'дивиденды',
  'дивиденд', 'штраф', 'налог', 'tax', 'penalty', 'зарплат', 'з/п',
  'зарплата', 'salary', 'членский', 'membership', 'взнос', 'страхов',
  'безвозмездная', 'терминал id', 'cash in', 'cash in&out',
  'наличность в терминалах', 'наличность в эле', 'пополнение через терминал',
  'пополнение те', 'безвозмездный', 'материальная помощь',
]

const safeJsonParse = (value) => {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const normalizeStructuredValue = (value) => {
  if (!value) return null
  if (typeof value === 'object') return value
  return safeJsonParse(value)
}

const normalizeWhitespace = (value) =>
  (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

const getFieldValue = (transaction, keys) => {
  if (!transaction || typeof transaction !== 'object') return ''
  for (const key of keys) {
    if (transaction[key] !== undefined && transaction[key] !== null) {
      const value = transaction[key]
      if (typeof value === 'string') return value
      if (typeof value === 'number') return value.toString()
    }
  }
  return ''
}

const extractPurpose = (transaction) =>
  normalizeWhitespace(
    getFieldValue(transaction, [
      'Назначение платежа', 'назначение платежа', 'Назначение', 'назначение',
      'Purpose', 'purpose', 'Комментарий', 'comment', 'description', 'Description', 'Details',
    ])
  )

const extractSender = (transaction) =>
  normalizeWhitespace(
    getFieldValue(transaction, [
      'Отправитель', 'отправитель', 'Плательщик', 'плательщик',
      'Контрагент', 'counterparty', 'sender', 'payer',
    ])
  )

const extractCorrespondent = (transaction) =>
  normalizeWhitespace(
    getFieldValue(transaction, [
      'Корреспондент', 'корреспондент', 'Correspondent', 'correspondent',
      'Получатель', 'получатель', 'Beneficiary', 'beneficiary', 'counterparty',
    ])
  )

const extractAmountRaw = (transaction) =>
  getFieldValue(transaction, [
    'Кредит', 'credit', 'Сумма', 'сумма', 'Amount', 'amount', 'value',
  ])

const sanitizeNumberString = (value) => {
  if (typeof value !== 'string') return ''
  let cleaned = value
    .replace(/\u00a0/g, '').replace(/\u202f/g, '').replace(/\s+/g, '')
    .replace(/[''`´]/g, '').trim()
  if (!cleaned) return ''

  let negative = false
  if (cleaned.startsWith('-')) {
    negative = true
    cleaned = cleaned.slice(1)
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1)
  }

  let numeric = cleaned.replace(/[^0-9,.\-]/g, '')
  if (!numeric) return ''

  if (numeric.startsWith('-')) {
    negative = true
    numeric = numeric.slice(1)
  }
  numeric = numeric.replace(/-/g, '')

  const hasComma = numeric.includes(',')
  const hasDot = numeric.includes('.')

  if (hasComma && hasDot) {
    if (numeric.lastIndexOf(',') > numeric.lastIndexOf('.')) {
      numeric = numeric.replace(/\./g, '').replace(',', '.')
    } else {
      numeric = numeric.replace(/,/g, '')
    }
    return (negative ? '-' : '') + numeric
  }

  const separatorIndex = Math.max(numeric.lastIndexOf(','), numeric.lastIndexOf('.'))
  if (separatorIndex === -1) {
    return (negative ? '-' : '') + numeric
  }

  const separator = numeric[separatorIndex]
  const fractionalLength = numeric.length - separatorIndex - 1
  const separatorsCount = (numeric.match(new RegExp(`\\${separator}`, 'g')) || []).length

  const treatAsDecimal =
    fractionalLength > 0 &&
    fractionalLength <= 2 &&
    (separatorsCount === 1 || separator === ',')

  if (treatAsDecimal) {
    const integerPart = numeric.slice(0, separatorIndex).replace(/[^0-9]/g, '') || '0'
    const fractionalPart = numeric.slice(separatorIndex + 1).replace(/[^0-9]/g, '')
    if (!fractionalPart) {
      return (negative ? '-' : '') + integerPart
    }
    return `${negative ? '-' : ''}${integerPart}.${fractionalPart}`
  }

  const stripped = numeric.replace(new RegExp(`\\${separator}`, 'g'), '')
  return (negative ? '-' : '') + stripped
}

const parseAmountNumber = (value) => {
  if (value === null || value === undefined) return 0
  const stringValue = typeof value === 'number' ? value.toString() : String(value)
  const sanitized = sanitizeNumberString(stringValue)
  if (!sanitized) return 0
  const parsed = Number(sanitized)
  return Number.isFinite(parsed) ? parsed : 0
}

const tryParseDate = (value) => {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  
  if (typeof value === 'number') {
    if (value > 0 && value < 1000000) {
      const excelEpoch = new Date(Date.UTC(1899, 11, 30))
      const days = Math.floor(value)
      const milliseconds = (value - days) * 86400000
      excelEpoch.setUTCDate(excelEpoch.getUTCDate() + days)
      excelEpoch.setUTCMilliseconds(excelEpoch.getUTCMilliseconds() + milliseconds)
      
      const currentYear = new Date().getUTCFullYear()
      const dateYear = excelEpoch.getUTCFullYear()
      if (dateYear >= 1990 && dateYear <= currentYear + 1 && !Number.isNaN(excelEpoch.getTime())) {
        return excelEpoch
      }
    }
    if (value > 946684800000) {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) return date
    }
  }
  
  const raw = value.toString().trim()
  if (!raw || raw === 'null' || raw === 'undefined' || raw === 'NaN' || raw.toLowerCase() === 'none') return null
  
  const incompleteDotMatch = raw.match(/^\.(\d{1,2})\.(\d{2,4})$/)
  if (incompleteDotMatch) {
    const [, mm, yy] = incompleteDotMatch
    const month = Number(mm) - 1
    const year = yy.length === 2 ? Number(yy) + (Number(yy) > 70 ? 1900 : 2000) : Number(yy)
    const date = new Date(Date.UTC(year, month, 1))
    return Number.isNaN(date.getTime()) ? null : date
  }
  
  const dotTimeMatch = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/)
  if (dotTimeMatch) {
    const [, dd, mm, yy, hh, min, ss] = dotTimeMatch
    const day = Number(dd)
    const month = Number(mm) - 1
    const year = yy.length === 2 ? Number(yy) + (Number(yy) > 70 ? 1900 : 2000) : Number(yy)
    
    if (day < 1 || day > 31 || month < 0 || month > 11) return null
    
    const hour = Number(hh)
    const minute = Number(min)
    const second = Number(ss)
    const date = new Date(Date.UTC(year, month, day, hour, minute, second))
    return Number.isNaN(date.getTime()) ? null : date
  }
  
  const dotMatch = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/)
  if (dotMatch) {
    const [, dd, mm, yy] = dotMatch
    const day = Number(dd)
    const month = Number(mm) - 1
    const year = yy.length === 2 ? Number(yy) + (Number(yy) > 70 ? 1900 : 2000) : Number(yy)
    
    if (day < 1 || day > 31 || month < 0 || month > 11) return null
    
    const date = new Date(Date.UTC(year, month, day))
    return Number.isNaN(date.getTime()) ? null : date
  }
  
  const direct = Date.parse(raw)
  if (!Number.isNaN(direct)) {
    if (raw.match(/^\d{4}-\d{2}-\d{2}/) || raw.match(/^\d{4}\/\d{2}\/\d{2}/)) {
      return new Date(direct)
    }
    if (!raw.match(/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/)) {
      return new Date(direct)
    }
  }
  
  const monthWords = {
    января: 0, февраль: 1, февраля: 1, февр: 1, фев: 1,
    март: 2, марта: 2, мар: 2, апрель: 3, апреля: 3, апр: 3,
    май: 4, мая: 4, июнь: 5, июня: 5, июль: 6, июля: 6,
    август: 7, августа: 7, авг: 7, сентябрь: 8, сентября: 8, сент: 8,
    октябрь: 9, октября: 9, окт: 9, ноябрь: 10, ноября: 10, нояб: 10,
    декабрь: 11, декабря: 11, дек: 11,
  }
  
  const wordMatch = raw.toLowerCase().match(/^(\d{1,2})\s+([а-яa-z]+)\.?\s+(\d{2,4})\s*(?:г\.?)?$/i)
  if (wordMatch) {
    const [, dd, monthWord, yy] = wordMatch
    const cleanMonthWord = monthWord.replace(/\.$/, '')
    const month = monthWords[cleanMonthWord]
    if (month !== undefined) {
      const day = Number(dd)
      const year = yy.length === 2 ? Number(yy) + (Number(yy) > 70 ? 1900 : 2000) : Number(yy)
      const date = new Date(Date.UTC(year, month, day))
      return Number.isNaN(date.getTime()) ? null : date
    }
  }
  return null
}

const TRANSACTION_DATE_KEYS = [
  'Дата', 'дата', 'Date', 'date', 'та',
  'Дата операции', 'дата операции', 'Дата платежа', 'дата платежа',
  'Дата документа', 'дата документа', 'operation date', 'transaction date',
  'Value Date', 'value date', 'күні',
]

const extractTransactionDate = (transaction) => {
  let value = getFieldValue(transaction, TRANSACTION_DATE_KEYS)
  let parsed = value ? tryParseDate(value) : null
  
  if (parsed) return parsed
  
  if (transaction && typeof transaction === 'object') {
    const hasCredit = parseAmountNumber(extractAmountRaw(transaction)) > 0
    const datePattern = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?)/g
    
    for (const [key, val] of Object.entries(transaction)) {
      if (key.startsWith('_ikap_') || key === 'page_number' || key === 'bank_name') continue
      
      if (val && typeof val === 'string') {
        const trimmed = val.trim()
        if (!trimmed || trimmed.toLowerCase() === 'none') continue
        
        const matches = Array.from(trimmed.matchAll(datePattern))
        for (const match of matches) {
          let dateStr = match[0].trim().replace(/\s+[^\d:]+$/, '').trim()
          const parsedDate = tryParseDate(dateStr)
          if (parsedDate && !Number.isNaN(parsedDate.getTime())) {
            const currentYear = new Date().getUTCFullYear()
            const dateYear = parsedDate.getUTCFullYear()
            if (dateYear >= 2000 && dateYear <= currentYear + 2) {
              if (hasCredit) {
                console.log(`📅 Найдена дата в поле "${key}" (транзакция с кредитом): "${dateStr}" -> ${parsedDate.toISOString()}`)
              }
              return parsedDate
            }
          }
        }
      } else if (val && typeof val === 'number') {
        const parsedDate = tryParseDate(val)
        if (parsedDate && !Number.isNaN(parsedDate.getTime())) {
          const currentYear = new Date().getUTCFullYear()
          const dateYear = parsedDate.getUTCFullYear()
          if (dateYear >= 2000 && dateYear <= currentYear + 2) {
            if (hasCredit) {
              console.log(`📅 Найдена дата (число) в поле "${key}" (транзакция с кредитом): ${val} -> ${parsedDate.toISOString()}`)
            }
            return parsedDate
          }
        }
      }
    }
  }
  
  if (!parsed && value && value.toLowerCase() !== 'none') {
    if (typeof transaction === 'object' && transaction._ikap_date_warning_count === undefined) {
      transaction._ikap_date_warning_count = 1
      const hasCredit = parseAmountNumber(extractAmountRaw(transaction)) > 0
      console.warn(`⚠️ Не удалось распарсить дату из значения: "${value}" (транзакция ${hasCredit ? 'с кредитом' : 'без кредита'})`, {
        availableKeys: Object.keys(transaction).filter(k => k !== '_ikap_date_warning_count'),
        transactionSample: Object.fromEntries(Object.entries(transaction).slice(0, 5))
      })
    }
  }
  
  return parsed || null
}

const formatCurrencyKzt = (amount) => {
  const normalized = Number.isFinite(amount) ? amount : 0
  return `${normalized.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} KZT`
}

const classifyTransactionHeuristically = (transaction) => {
  const purpose = extractPurpose(transaction).toLowerCase()
  const sender = extractSender(transaction).toLowerCase()
  const combinedText = `${purpose} ${sender}`.toLowerCase()
  
  if (!purpose && !sender) {
    return { type: 'ambiguous', reason: 'нет назначения платежа и отправителя' }
  }
  
  const contains = (keywords, text) => keywords.some((keyword) => text.includes(keyword))
  
  const returnKeywords = ['возврат', 'возмещение']
  if (contains(returnKeywords, purpose)) {
    return { type: 'non_revenue', reason: 'обнаружены слова "возврат" или "возмещение" в назначении платежа' }
  }
  
  const terminalMarkers = [
    'терминал id', 'cash in', 'cash in&out', 'наличность в терминалах',
    'наличность в эле', 'пополнение через терминал',
  ]
  
  if (contains(terminalMarkers, combinedText)) {
    return { type: 'non_revenue', reason: 'пополнение через терминал - не выручка (собственные средства)' }
  }
  
  if (contains(NON_REVENUE_KEYWORDS, combinedText)) {
    return { type: 'non_revenue', reason: 'обнаружены маркеры невыручки' }
  }
  
  if (contains(REVENUE_KEYWORDS, purpose)) {
    return { type: 'revenue', reason: 'обнаружены маркеры выручки' }
  }
  
  if (purpose.includes('пополнение') || purpose.includes('перевод')) {
    return { type: 'ambiguous', reason: 'пополнение/перевод требует анализа контекста' }
  }
  
  return { type: 'ambiguous', reason: 'нет явных маркеров' }
}

const attachInternalTransactionIds = (transactions = [], sessionId) =>
  transactions.map((transaction, index) => {
    const existingId =
      transaction?._ikap_tx_id ||
      transaction?.transaction_id ||
      transaction?.id ||
      transaction?.ID
    const generatedId = existingId || `${sessionId || 'sess'}_${index + 1}`
    return {
      ...transaction,
      _ikap_tx_id: generatedId,
    }
  })

const splitTransactionsByConfidence = (transactions = []) => {
  const obviousRevenue = []
  const obviousNonRevenue = []
  const needsReview = []

  for (const transaction of transactions) {
    const classification = classifyTransactionHeuristically(transaction)
    if (classification.type === 'revenue') {
      obviousRevenue.push({
        ...transaction,
        _ikap_classification_source: 'heuristic',
        _ikap_classification_reason: classification.reason,
      })
      continue
    }
    if (classification.type === 'non_revenue') {
      obviousNonRevenue.push({
        ...transaction,
        _ikap_classification_source: 'heuristic',
        _ikap_classification_reason: classification.reason,
        _ikap_is_revenue: false,
      })
      continue
    }
    needsReview.push({
      ...transaction,
      _ikap_classification_source: 'agent_required',
      _ikap_classification_reason: classification.reason,
    })
  }

  return { obviousRevenue, obviousNonRevenue, needsReview }
}

const buildClassifierPrompt = (transactions) => {
  const simplified = transactions.map((transaction) => ({
    id: transaction._ikap_tx_id,
    date: getFieldValue(transaction, ['Дата', 'дата', 'Date', 'date']),
    amount: extractAmountRaw(transaction),
    purpose: extractPurpose(transaction),
    sender: extractSender(transaction),
    correspondent: getFieldValue(transaction, ['Корреспондент', 'корреспондент', 'Correspondent', 'correspondent']),
    bin: getFieldValue(transaction, ['БИН/ИИН', 'БИН', 'ИИН', 'BIN', 'IIN', 'bin', 'iin']),
    comment: getFieldValue(transaction, ['Комментарий', 'comment', 'Примечание']),
  }))

  return [
    'Ниже операции, которые нужно классифицировать как выручка или нет.',
    'Верни JSON в соответствии с инструкцией, без дополнительных пояснений.',
    'transactions_for_review:',
    '```json',
    JSON.stringify(simplified, null, 2),
    '```',
  ]
    .filter(Boolean)
    .join('\n')
}

const parseClassifierResponse = (text) => {
  if (!text) return []
  const parsed = safeJsonParse(text)
  if (!parsed) return []
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.transactions)) return parsed.transactions
  return []
}

const aggregateByYearMonth = (transactions = []) => {
  const yearMap = new Map()

  for (const transaction of transactions) {
    const amount = parseAmountNumber(extractAmountRaw(transaction))
    if (!amount) continue
    const date = extractTransactionDate(transaction)
    if (!date || Number.isNaN(date.getTime())) continue
    
    const currentDate = new Date()
    const maxAllowedDate = new Date(currentDate)
    maxAllowedDate.setDate(maxAllowedDate.getDate() + 3)
    if (date > maxAllowedDate) {
      console.warn('⚠️ Транзакция с датой в будущем пропущена при группировке:', {
        date: date.toISOString(),
        amount,
        purpose: extractPurpose(transaction),
      })
      continue
    }
    
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth()
    const yearEntry = yearMap.get(year) || { total: 0, months: new Map() }
    yearEntry.total += amount
    const monthValue = yearEntry.months.get(month) || 0
    yearEntry.months.set(month, monthValue + amount)
    yearMap.set(year, yearEntry)
  }

  return Array.from(yearMap.entries())
    .sort(([yearA], [yearB]) => yearA - yearB)
    .map(([year, data]) => ({
      year,
      value: data.total,
      formatted: formatCurrencyKzt(data.total),
      months: Array.from(data.months.entries())
        .sort(([monthA], [monthB]) => monthA - monthB)
        .map(([month, value]) => ({
          month: MONTH_NAMES_RU[month] || String(month + 1),
          value,
          formatted: formatCurrencyKzt(value),
        })),
    }))
}

const computeTrailing12Months = (transactions = []) => {
  const dated = transactions
    .map((transaction) => ({
      amount: parseAmountNumber(extractAmountRaw(transaction)),
      date: extractTransactionDate(transaction),
    }))
    .filter((item) => item.amount && item.date)

  if (!dated.length) {
    return { total: 0, referenceDate: null }
  }

  const referenceDate = dated.reduce(
    (latest, current) => (current.date > latest ? current.date : latest),
    dated[0].date
  )
  const windowStart = new Date(referenceDate)
  windowStart.setUTCDate(1)
  windowStart.setUTCFullYear(referenceDate.getUTCFullYear())
  windowStart.setUTCMonth(referenceDate.getUTCMonth() - 11)

  const total = dated
    .filter((item) => item.date >= windowStart && item.date <= referenceDate)
    .reduce((sum, item) => sum + item.amount, 0)

  return { total, referenceDate }
}

const buildTransactionsPreview = (transactions = [], { limit = 50 } = {}) => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return []
  }

  return transactions.slice(0, limit).map((transaction) => {
    const amountRaw = extractAmountRaw(transaction)
    const amountValue = parseAmountNumber(amountRaw)
    const parsedDate = extractTransactionDate(transaction)
    const originalDate = getFieldValue(transaction, TRANSACTION_DATE_KEYS) || null

    return {
      id: transaction._ikap_tx_id || transaction.transaction_id || transaction.id || transaction.ID || null,
      amountRaw: amountRaw || null,
      amountValue: Number.isFinite(amountValue) && amountValue !== 0 ? amountValue : null,
      amountFormatted: Number.isFinite(amountValue) && amountValue !== 0 ? formatCurrencyKzt(amountValue) : null,
      date: parsedDate ? parsedDate.toISOString() : originalDate,
      purpose: extractPurpose(transaction) || null,
      sender: extractSender(transaction) || null,
      correspondent: extractCorrespondent(transaction) || null,
      source: transaction._ikap_classification_source || null,
      reason: transaction._ikap_classification_reason || null,
      possibleNonRevenue: Boolean(transaction._ikap_possible_non_revenue),
    }
  })
}

const buildStructuredSummary = ({
  revenueTransactions,
  nonRevenueTransactions,
  stats,
  autoRevenuePreview,
  convertedExcels,
}) => {
  const revenueSummary = aggregateByYearMonth(revenueTransactions)
  const nonRevenueSummary = aggregateByYearMonth(nonRevenueTransactions)
  
  const totalRevenue = revenueTransactions.reduce((sum, transaction) => {
    const amount = parseAmountNumber(extractAmountRaw(transaction))
    return sum + (amount || 0)
  }, 0)
  const totalNonRevenue = nonRevenueTransactions.reduce((sum, transaction) => {
    const amount = parseAmountNumber(extractAmountRaw(transaction))
    return sum + (amount || 0)
  }, 0)
  
  const revenueSummaryTotal = revenueSummary.reduce((sum, year) => sum + year.value, 0)
  const nonRevenueSummaryTotal = nonRevenueSummary.reduce((sum, year) => sum + year.value, 0)
  
  const revenueDifference = totalRevenue - revenueSummaryTotal
  const nonRevenueDifference = totalNonRevenue - nonRevenueSummaryTotal
  if (revenueDifference > 0.01 || nonRevenueDifference > 0.01) {
    console.log('📊 Разница между общей суммой и суммой по годам:', {
      revenue: { total: totalRevenue, byYears: revenueSummaryTotal, difference: revenueDifference },
      nonRevenue: { total: totalNonRevenue, byYears: nonRevenueSummaryTotal, difference: nonRevenueDifference },
    })
  }
  
  const trailing = computeTrailing12Months(revenueTransactions)

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      revenue: { value: totalRevenue, formatted: formatCurrencyKzt(totalRevenue) },
      nonRevenue: { value: totalNonRevenue, formatted: formatCurrencyKzt(totalNonRevenue) },
    },
    revenue: {
      totalValue: totalRevenue,
      totalFormatted: formatCurrencyKzt(totalRevenue),
      years: revenueSummary,
    },
    nonRevenue: {
      totalValue: totalNonRevenue,
      totalFormatted: formatCurrencyKzt(totalNonRevenue),
      years: nonRevenueSummary,
    },
    trailing12MonthsRevenue: {
      value: trailing.total,
      formatted: formatCurrencyKzt(trailing.total),
      referencePeriodEndsAt: trailing.referenceDate ? trailing.referenceDate.toISOString() : null,
    },
    stats,
    autoRevenuePreview: Array.isArray(autoRevenuePreview) ? autoRevenuePreview : [],
    convertedExcels: Array.isArray(convertedExcels) ? convertedExcels : [],
  }
}

const formatReportAsText = (reportData) => {
  if (!reportData) return 'Отчёт недоступен.'
  
  if (typeof reportData === 'string') {
    try {
      const parsed = JSON.parse(reportData)
      return formatReportAsText(parsed)
    } catch {
      return reportData
    }
  }

  if (typeof reportData !== 'object' || Array.isArray(reportData)) {
    return JSON.stringify(reportData, null, 2)
  }

  const lines = []
  
  lines.push('📊 ФИНАНСОВЫЙ ОТЧЁТ')
  lines.push('')
  
  if (reportData.generatedAt) {
    const date = new Date(reportData.generatedAt)
    lines.push(`Дата формирования: ${date.toLocaleString('ru-RU', { 
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' 
    })}`)
    lines.push('')
  }

  if (reportData.totals) {
    lines.push('💰 ИТОГОВЫЕ СУММЫ')
    lines.push('')
    if (reportData.totals.revenue) {
      lines.push(`Выручка: ${reportData.totals.revenue.formatted || formatCurrencyKzt(reportData.totals.revenue.value || 0)}`)
    }
    if (reportData.totals.nonRevenue) {
      lines.push(`Не выручка: ${reportData.totals.nonRevenue.formatted || formatCurrencyKzt(reportData.totals.nonRevenue.value || 0)}`)
    }
    lines.push('')
  }

  if (reportData.revenue && reportData.revenue.years) {
    lines.push('📈 ВЫРУЧКА')
    lines.push('')
    lines.push(`Общая сумма: ${reportData.revenue.totalFormatted || formatCurrencyKzt(reportData.revenue.totalValue || 0)}`)
    lines.push('')
    
    for (const yearData of reportData.revenue.years) {
      lines.push(`Год ${yearData.year}: ${formatCurrencyKzt(yearData.value || 0)}`)
      
      if (yearData.months && yearData.months.length > 0) {
        for (const monthData of yearData.months) {
          const monthName = monthData.month || MONTH_NAMES_RU[monthData.monthIndex] || 'неизвестно'
          lines.push(`  • ${monthName.charAt(0).toUpperCase() + monthName.slice(1)}: ${monthData.formatted || formatCurrencyKzt(monthData.value || 0)}`)
        }
      }
      lines.push('')
    }
  }

  if (reportData.nonRevenue && reportData.nonRevenue.years) {
    lines.push('📉 НЕ ВЫРУЧКА')
    lines.push('')
    lines.push(`Общая сумма: ${reportData.nonRevenue.totalFormatted || formatCurrencyKzt(reportData.nonRevenue.totalValue || 0)}`)
    lines.push('')
    
    for (const yearData of reportData.nonRevenue.years) {
      lines.push(`Год ${yearData.year}: ${formatCurrencyKzt(yearData.value || 0)}`)
      
      if (yearData.months && yearData.months.length > 0) {
        for (const monthData of yearData.months) {
          const monthName = monthData.month || MONTH_NAMES_RU[monthData.monthIndex] || 'неизвестно'
          lines.push(`  • ${monthName.charAt(0).toUpperCase() + monthName.slice(1)}: ${monthData.formatted || formatCurrencyKzt(monthData.value || 0)}`)
        }
      }
      lines.push('')
    }
  }

  if (reportData.trailing12MonthsRevenue) {
    lines.push('📅 ВЫРУЧКА ЗА ПОСЛЕДНИЕ 12 МЕСЯЦЕВ')
    lines.push('')
    lines.push(`Сумма: ${reportData.trailing12MonthsRevenue.formatted || formatCurrencyKzt(reportData.trailing12MonthsRevenue.value || 0)}`)
    if (reportData.trailing12MonthsRevenue.referencePeriodEndsAt) {
      const refDate = new Date(reportData.trailing12MonthsRevenue.referencePeriodEndsAt)
      lines.push(`Период заканчивается: ${refDate.toLocaleDateString('ru-RU', { 
        year: 'numeric', month: 'long', day: 'numeric' 
      })}`)
    }
    lines.push('')
  }

  if (reportData.stats) {
    lines.push('📊 СТАТИСТИКА')
    lines.push('')
    if (reportData.stats.totalTransactions !== undefined) {
      lines.push(`Всего транзакций: ${reportData.stats.totalTransactions}`)
    }
    if (reportData.stats.autoRevenue !== undefined) {
      lines.push(`Автоматически классифицировано как выручка: ${reportData.stats.autoRevenue}`)
    }
    if (reportData.stats.agentReviewed !== undefined) {
      lines.push(`Проверено агентом: ${reportData.stats.agentReviewed}`)
    }
    if (reportData.stats.agentDecisions !== undefined) {
      lines.push(`Решений от агента: ${reportData.stats.agentDecisions}`)
    }
    if (reportData.stats.unresolved !== undefined && reportData.stats.unresolved > 0) {
      lines.push(`Неразрешённых: ${reportData.stats.unresolved}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

const ensureHumanReadableReportText = (row) => {
  if (!row) return row
  const structured = normalizeStructuredValue(row.report_structured)
  if (structured && typeof structured === 'object') {
    row.report_text = formatReportAsText(structured)
    return row
  }
  if (row.report_text) {
    const parsed = normalizeStructuredValue(row.report_text)
    if (parsed && typeof parsed === 'object' && (parsed.generatedAt || parsed.totals || parsed.revenue)) {
      row.report_text = formatReportAsText(parsed)
    }
  }
  return row
}

const normalizeMetadata = (raw) => {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.warn('⚠️ Не удалось распарсить metadata, оставляем как строку', raw, error)
    return { raw }
  }
}

const extractAssistantAnswer = (items) => {
  if (!Array.isArray(items)) return ''
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const entry = items[index]
    const payload = entry?.rawItem || entry
    if (!payload || typeof payload !== 'object') continue
    const role = payload.role
    if (role !== 'assistant') continue
    const content = payload.content
    if (typeof content === 'string') {
      const trimmed = content.trim()
      if (trimmed) return trimmed
      continue
    }
    if (Array.isArray(content)) {
      for (const contentItem of content) {
        const text = (typeof contentItem === 'string' ? contentItem : (contentItem?.text || contentItem?.text?.value || '')).trim()
        if (text) return text
      }
    }
  }
  return ''
}

const transactionClassifierInstructions = `Ты финансовый аналитик iKapitalist. Твоя задача — классифицировать операции, по которым нет однозначного понимания, является ли поступление выручкой от реализации товаров/услуг или нет.

Данные:
- Ты получишь JSON-массив \`transactions_for_review\`.
- Каждая операция имеет поля: \`id\`, \`date\`, \`amount\`, \`purpose\`, иногда \`sender\`, \`comment\`, \`correspondent\`, \`bin\`.

Требования:
1. Для каждой операции верни признак \`is_revenue\` (true/false) и короткое объяснение \`reason\`.
2. Считай выручкой платежи клиентов за товары/услуги или их прямые аналоги ("оплата", "реализация", "invoice", "services", "goods", "договор поставки", "СФ", "счет-фактура", "акт оказанных услуг" и т.п.).
3. НЕ относись к выручке:
   - КРИТИЧЕСКИ ВАЖНО: Если в назначении платежа есть слова "возврат" или "возмещение" — это точно НЕ выручка (даже если есть другие маркеры выручки)
   - Явные возвраты ("возврат средств", "возврат за непредоставленные", "refund", "возмещение")
   - Переводы между собственными счетами одной компании (если видно по БИН/ИИН или названию)
   - Займы/кредиты, инвестиции, субсидии, депозиты, дивиденды, зарплаты, налоги, штрафы
   - Безвозмездная помощь, материальная помощь
   - Пополнение счета через терминал/банкомат ("cash in", "cash in&out", "наличность в терминалах", "пополнение через терминал") — это перевод собственных средств, НЕ выручка
   - Внесение наличных владельцем счета в терминал/банкомат для пополнения собственного счета
4. Особые случаи:
   - "Пополнение счета" БЕЗ упоминания терминала/банкомата — может быть выручкой, если это пополнение от клиента (проверь корреспондента и БИН)
   - "Пополнение счета" С упоминанием "терминал", "cash in", "банкомат" — НЕ выручка (это собственные средства владельца)
   - "Перевод со счета карты" — может быть выручкой, если это перевод от клиента на счет компании (проверь контекст)
   - Если в назначении есть упоминание договора, счета-фактуры, акта, услуг, работ — скорее всего выручка
   - Если перевод между счетами одной компании (одинаковый БИН/ИИН) — не выручка
5. Анализируй контекст:
   - Проверяй поле \`correspondent\` (корреспондент) — если это известный клиент или организация, это может быть выручка
   - Проверяй поле \`sender\` (отправитель) — если там "Наличность в терминалах", "cash in", "терминал" — это НЕ выручка
   - Проверяй поле \`bin\` (БИН/ИИН) — если совпадает с получателем, это внутренний перевод
   - Если в назначении есть номера договоров, счетов-фактур, актов — это обычно выручка
   - Всегда рассматривай формулировки наподобие "Продажи с Kaspi.kz" как выручку (это marketplace-выручка)
6. Если формулировка явно указывает на продажу товаров/услуг — ставь true.
7. Если текст нейтральный, но похож на оплату клиента (invoice, payment for contract, СФ, акт) — выбирай true.
8. Если сомневаешься — анализируй контекст (отправитель, корреспондент, БИН, наличие договоров/счетов). Если видны признаки пополнения через терминал или собственных средств — выбирай false.

Формат ответа — строго JSON без текста:
{
  "transactions": [
    { "id": "tx_1", "is_revenue": true, "reason": "оплата по договору поставки", "date", "amount" }
  ]
}`

module.exports = {
  safeJsonParse,
  normalizeStructuredValue,
  normalizeMetadata,
  extractPurpose,
  extractSender,
  extractCorrespondent,
  extractAmountRaw,
  parseAmountNumber,
  tryParseDate,
  extractTransactionDate,
  formatCurrencyKzt,
  classifyTransactionHeuristically,
  attachInternalTransactionIds,
  splitTransactionsByConfidence,
  buildClassifierPrompt,
  parseClassifierResponse,
  aggregateByYearMonth,
  computeTrailing12Months,
  buildTransactionsPreview,
  buildStructuredSummary,
  formatReportAsText,
  ensureHumanReadableReportText,
  extractAssistantAnswer,
  transactionClassifierInstructions,
  TRANSACTION_DATE_KEYS,
  MONTH_NAMES_RU,
}

