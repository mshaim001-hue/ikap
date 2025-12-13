'use strict'

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const server = new McpServer({
  name: 'ikapitalist-info',
  version: '1.1.0'
})

// Годовая ставка по умолчанию - берется из переменной окружения или 0.3 (30%)
const DEFAULT_ANNUAL_RATE = process.env.DEFAULT_ANNUAL_RATE 
  ? parseFloat(process.env.DEFAULT_ANNUAL_RATE) 
  : 0.3

/** @type {Record<string, string>} */
const sections = {
  overview: [
    '# Обзор iKapitalist',
    '',
    'iKapitalist — лицензированная инвестиционная и заёмная краудфандинговая платформа, работающая с 2019 года.',
    'Платформа помогает малому и среднему бизнесу привлекать финансирование от инвесторов на прозрачных условиях.',
    'Инвесторы могут выдавать займы или покупать доли в компаниях, получая доходность от 24% годовых.',
    '',
    '**Ключевые факты:**',
    '- Запуск: 2019 год',
    '- Лицензия AFSA-А-LA-2023-0005 (Астана, МФЦА)',
    '- Управление инвестиционной и заёмной краудфандинговой платформой',
    '- Возможность прямого общения инвесторов с собственниками бизнеса'
  ].join('\n'),
  licensing: [
    '# Лицензирование и регулирование',
    '',
    'Платформа iKapitalist.kz зарегистрирована в юрисдикции Международного финансового центра «Астана» (МФЦА) и регулируется Управлением по финансовым услугам AFSA.',
    '',
    '**Лицензия:**',
    '- Номер: AFSA-A-LA-2023-0005',
    '- Дата выдачи: 27.04.2023',
    '- Статус: активна',
    '- Деятельность: управление инвестиционной и заёмной краудфандинговой платформой и платформой заемного финансирования'
  ].join('\n'),
  products: [
    '# Инвестиционные продукты',
    '',
    'Платформа предлагает несколько форматов финансирования для инвесторов и компаний-заёмщиков:',
    '',
    '- **Займы:** фиксированная ставка от 30% годовых, срок 4–36 месяцев, сумма от 10 млн до 1 млрд ₸',
    '- **Облигации:** инструмент привлечения долгового капитала',
    '- **Доли бизнеса:** участие в капитале растущих компаний',
    '',
    'Все сделки оформляются в соответствии с нормами AFSA, платформа собирает личные гарантии и поручительства предпринимателей.'
  ].join('\n'),
  operations: [
    '# Как работает платформа',
    '',
    '1. iKapitalist отбирает предложения компаний-заёмщиков, проводит проверку налоговой и финансовой отчётности, кредитного отчёта и учредительных документов.',
    '2. После проверки инвестиционное предложение публикуется на платформе (AFSA не проверяет данные компаний).',
    '3. Инвесторы самостоятельно принимают решение о вложениях, опираясь на опубликованную информацию.',
    '4. После сбора полной суммы инвестиций запускается 48-часовой период заморозки, когда инвесторы могут бесплатно отменить заявки.',
    '5. По завершении заморозки iKapitalist подготавливает и организует подписание договоров, собирает средства и перечисляет их компании.',
    '6. На протяжении всего срока займа платформа администрирует платежи, следит за выполнением обязательств и взаимодействует со сторонами.',
    '7. Комиссии платформы: с компаний — за привлечение финансирования, с инвесторов — по завершении договоров займа.'
  ].join('\n'),
  default_management: [
    '# Действия при просрочках и дефолте',
    '',
    'Если заемщик просрочил оплату, платформа контактирует его, выясняет причины и начисляет неустойку.',
    'При просрочке свыше 60 дней статус сделки меняется на «дефолт». Платформа инициирует переуступку прав требования задолженности и начинает процедуру взыскания от имени всех инвесторов.',
    'Инвестор может отказаться от переуступки и заниматься взысканием самостоятельно — платформа предоставит все необходимые документы и данные по сделке.'
  ].join('\n'),
  legal_framework: [
    '# Правовое регулирование договоров',
    '',
    'Все договоры займа между инвестором и заемщиком регулируются законодательством Международного Финансового Центра Астана, действующего в соответствии с конституционным законом «О МФЦА».'
  ].join('\n'),
  material_changes: [
    '# Порядок действий при изменениях условий займа',
    '',
    'Платформа уведомляет инвесторов о значимых изменениях в обстоятельствах заемщика через личный кабинет и, при необходимости, организует онлайн-звонки.',
    'Если изменения выявлены до подписания договоров, проводится голосование: решение продолжается при согласии инвесторов на сумму ≥90% финансирования, иначе сделка возвращается на этап привлечения.',
    'Если существенные изменения выявлены на стадии исполнения договоров, платформа вправе с согласия инвесторов объявить дефолт и потребовать досрочного возврата займа.'
  ].join('\n'),
  aml: [
    '# Процедуры AML/CFT',
    '',
    'Все компании и инвесторы проходят проверку по требованиям противодействия отмыванию денег и финансированию терроризма (AML/CFT).',
    'Процедура охватывает более 60 параметров, включая аресты, налоговые задолженности, текущие судебные разбирательства.',
    'Подозрительные транзакции передаются в уполномоченный государственный орган финансового мониторинга Республики Казахстан.'
  ].join('\n'),
  contingency: [
    '# План непрерывности бизнеса',
    '',
    'На случай сбоев или прекращения деятельности iKapitalist предусмотрены меры:',
    '- резервные серверы для сохранности данных;',
    '- коммуникационный план для оперативного уведомления инвесторов;',
    '- соблюдение обязательных нормативных требований и отчетности;',
    '- предоставление инвесторам прямого доступа к контактам заемщиков, графикам платежей и инструкциям для самостоятельного взыскания при необходимости;',
    '- выполнение текущих обязательств перед инвесторами по мере возможностей даже при прекращении работы.'
  ].join('\n'),
  contacts: [
    '# Контакты iKapitalist',
    '',
    'Адрес: Мангилик Ел, 55/21, блок С4.2, офис 265, Астана, Казахстан',
    'Телефон: +7 700 178 00 18',
    'Электронная почта: claims@ikapitalist.kz',
    '',
    'Регулятор AFSA:',
    '- Адрес: ул. Мангилик Ел 55/17, блок C3.2, Астана, Казахстан',
    '- Телефон: +7 (7172) 64 73 71',
    '- Email: apd@afsa.kz'
  ].join('\n'),
  complaints: [
    '# Политика обработки жалоб',
    '',
    'Жалоба — выраженное недовольство услугами, продуктами, сотрудниками или процессом рассмотрения жалоб, когда ожидается ответ.',
    '',
    '**Основные принципы:**',
    '- Платформа поощряет получение обратной связи и обеспечивает своевременное рассмотрение жалоб.',
    '- Жалобы не принимаются анонимно.',
    '- Предоставляются понятные процедуры, несколько каналов подачи и уважительное отношение к заявителям.',
    '- Платформа защищает заявителей от негативных последствий за факт подачи жалобы.',
    '- Возможна помощь представителя заявителя по его желанию.',
    '',
    '**Процесс рассмотрения:**',
    '1. Регистрация жалобы и присвоение уникального идентификатора.',
    '2. Подтверждение получения жалобы в течение 3 рабочих дней.',
    '3. Оценка срочности и серьезности, определение необходимости дополнительного участия других организаций.',
    '4. Рассмотрение, сбор дополнительных данных и информирование заявителя о ходе и результатах.',
    '5. Предоставление оснований решения, возможных компенсаций и вариантов пересмотра.',
    '6. Ведение учета, отчетность, мониторинг выполнения принятых мер.',
    '',
    'Для соответствия правилам AFSA на сайте и в офисах публикуются контакты для жалоб и указание на возможность обращения напрямую в AFSA.'
  ].join('\n'),
  risks: [
    '# Основные риски инвесторов',
    '',
    '- **Риск потери средств:** заемщики могут не выполнить обязательства, особенно в сегменте МСБ.',
    '- **Риск по акциям:** отсутствует гарантия дивидендов, возможна допэмиссия и размытие доли; при частично оплаченных акциях инвестор обязан внести оставшиеся суммы.',
    '- **Высокий риск сектора МСБ:** вероятность неудачи бизнеса выше средней.',
    '- **Ликвидность:** продажа доли или займа может быть сложной, вторичный рынок не гарантирует быструю сделку.',
    '- **Закрытие платформы:** возможны задержки и расходы при прекращении работы платформы.',
    '- **Иностранные компании:** регулирование другой юрисдикцией, дополнительные налоги, комиссии, валютный контроль.',
    '- **Ограничения раскрытия:** эмитенты не обязаны предоставлять полный пакет данных, возможен дефицит информации.',
    '- **Неточность отчетности:** финансовая отчетность может быть неаудированной и содержать ошибки.',
    '- **Недостаточная диверсификация:** концентрация вложений в одной сделке повышает вероятность значительных потерь.'
  ].join('\n'),
  company_loans: [
    '# Виды займов для компаний',
    '',
    'Платформа предлагает четыре основных формата погашения долга для компаний-заёмщиков. Ниже приведено краткое описание и ключевые особенности каждого вида.',
    '',
    '1. **Ежемесячные проценты, основной долг в конце срока**',
    '   - Заёмщик перечисляет только проценты каждый месяц.',
    '   - В последний месяц оплачивается очередной процент и вся сумма основного долга.',
    '   - Удобно для бизнеса, который ожидает крупный денежный поток к окончанию срока.',
    '',
    '2. **Равномерное погашение основного долга (аннуитетная логика)**',
    '   - Основной долг делится на равные части и выплачивается ежемесячно.',
    '   - Проценты начисляются на оставшийся основной долг, поэтому ежемесячный платёж постепенно снижается.',
    '   - Возможна отсрочка по основному долгу: в период отсрочки платятся только проценты.',
    '',
    '3. **Фиксированная сумма платежа (равные доли основного долга и процентов)**',
    '   - Основной долг гасится равными долями каждый месяц.',
    '   - Проценты рассчитываются от первоначальной суммы займа, поэтому ежемесячный платёж остаётся постоянным.',
    '   - Может предусматривать отсрочку начала погашения основного долга с оплатой процентов.',
    '',
    '4. **Полное погашение в конце срока**',
    '   - Компании удобно, если денежный поток ожидается разово к моменту завершения проекта.',
    '   - В конце срока выплачивается сумма основного долга и начисленные проценты.',
    '',
    `Все расчёты по умолчанию ведутся исходя из 30% годовых (monthly = годовая ставка / 12), но могут быть скорректированы по договорённости с инвесторами.`
  ].join('\n')
}

const sectionIds = Object.keys(sections)

sectionIds.forEach((sectionId) => {
  const text = sections[sectionId]
  server.registerResource(
    `ikapitalist-${sectionId}`,
    `ikapitalist://${sectionId}`,
    {
      title: `iKapitalist · ${sectionId.replace(/_/g, ' ')}`,
      description: `Информация о разделе "${sectionId}" платформы iKapitalist`,
      mimeType: 'text/markdown'
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text,
          mimeType: 'text/markdown'
        }
      ]
    })
  )
})

server.registerTool(
  'ikapitalist_get_section',
  {
    title: 'Получить раздел справки iKapitalist',
    description: 'Возвращает структурированный текст по ключевому разделу справки платформы iKapitalist.',
    inputSchema: {
      section: z.enum(sectionIds).optional()
    },
    outputSchema: {
      section: z.string(),
      text: z.string()
    }
  },
  async ({ section }) => {
    const key = section || 'overview'
    const text = sections[key]
    if (!text) {
      return {
        content: [
          {
            type: 'text',
            text: `Раздел "${section}" не найден. Доступные разделы: ${sectionIds.join(', ')}.`
          }
        ],
        isError: true
      }
    }

    const payload = {
      section: key,
      text
    }

    return {
      content: [
        {
          type: 'text',
          text
        }
      ],
      structuredContent: payload
    }
  }
)

const loanTypeEnum = z.enum([
  'interest_only',
  'equal_principal',
  'fixed_payment',
  'lump_sum'
])

/**
 * @param {number} amount
 * @param {number} termMonths
 * @param {number} annualRate
 */
const getMonthlyRate = (amount, termMonths, annualRate) => {
  if (amount <= 0) {
    throw new Error('Сумма займа должна быть больше 0.')
  }

  if (termMonths <= 0) {
    throw new Error('Срок займа в месяцах должен быть больше 0.')
  }

  if (annualRate <= 0) {
    throw new Error('Годовая ставка должна быть больше 0.')
  }

  return annualRate / 12
}

/**
 * @typedef {Object} PaymentRow
 * @property {number} month
 * @property {number} payment
 * @property {number} principal
 * @property {number} interest
 * @property {number} remainingPrincipal
 */

/**
 * @param {number} amount
 * @param {number} termMonths
 * @param {number} annualRate
 * @returns {{ schedule: PaymentRow[], totals: { interest: number, principal: number, payments: number } }}
 */
const calculateInterestOnlySchedule = (amount, termMonths, annualRate) => {
  const monthlyRate = getMonthlyRate(amount, termMonths, annualRate)
  const monthlyInterest = amount * monthlyRate

  /** @type {PaymentRow[]} */
  const schedule = []
  let totalInterest = 0

  for (let month = 1; month <= termMonths; month += 1) {
    const interest = monthlyInterest
    const principal = month === termMonths ? amount : 0
    const payment = interest + principal
    const remainingPrincipal = month === termMonths ? 0 : amount

    totalInterest += interest

    schedule.push({
      month,
      payment,
      principal,
      interest,
      remainingPrincipal
    })
  }

  const totals = {
    interest: totalInterest,
    principal: amount,
    payments: amount + totalInterest
  }

  return { schedule, totals }
}

/**
 * @param {number} amount
 * @param {number} termMonths
 * @param {number} annualRate
 * @returns {{ schedule: PaymentRow[], totals: { interest: number, principal: number, payments: number } }}
 */
const calculateEqualPrincipalSchedule = (amount, termMonths, annualRate) => {
  const monthlyRate = getMonthlyRate(amount, termMonths, annualRate)
  const basePrincipalPayment = amount / termMonths

  /** @type {PaymentRow[]} */
  const schedule = []
  let remainingPrincipal = amount
  let totalInterest = 0
  let totalPayments = 0

  for (let month = 1; month <= termMonths; month += 1) {
    const principalPayment =
      month === termMonths ? remainingPrincipal : basePrincipalPayment
    const interest = remainingPrincipal * monthlyRate
    const payment = principalPayment + interest

    remainingPrincipal -= principalPayment

    totalInterest += interest
    totalPayments += payment

    schedule.push({
      month,
      payment,
      principal: principalPayment,
      interest,
      remainingPrincipal: Math.max(remainingPrincipal, 0)
    })
  }

  const totals = {
    interest: totalInterest,
    principal: amount,
    payments: totalPayments
  }

  return { schedule, totals }
}

/**
 * @param {number} amount
 * @param {number} termMonths
 * @param {number} annualRate
 * @returns {{ schedule: PaymentRow[], totals: { interest: number, principal: number, payments: number } }}
 */
const calculateFixedPaymentSchedule = (amount, termMonths, annualRate) => {
  const monthlyRate = getMonthlyRate(amount, termMonths, annualRate)
  const monthlyInterest = amount * monthlyRate
  const principalPayment = amount / termMonths
  const monthlyPayment = principalPayment + monthlyInterest

  /** @type {PaymentRow[]} */
  const schedule = []
  let remainingPrincipal = amount
  let totalInterest = 0
  let totalPayments = 0

  for (let month = 1; month <= termMonths; month += 1) {
    const principal =
      month === termMonths ? remainingPrincipal : principalPayment
    const payment = month === termMonths ? principal + monthlyInterest : monthlyPayment
    remainingPrincipal -= principal

    totalInterest += monthlyInterest
    totalPayments += payment

    schedule.push({
      month,
      payment,
      principal,
      interest: monthlyInterest,
      remainingPrincipal: Math.max(remainingPrincipal, 0)
    })
  }

  const totals = {
    interest: monthlyInterest * termMonths,
    principal: amount,
    payments: totalPayments
  }

  return { schedule, totals }
}

/**
 * @param {number} amount
 * @param {number} termMonths
 * @param {number} annualRate
 * @returns {{ schedule: PaymentRow[], totals: { interest: number, principal: number, payments: number } }}
 */
const calculateLumpSumSchedule = (amount, termMonths, annualRate) => {
  const monthlyRate = getMonthlyRate(amount, termMonths, annualRate)
  const totalInterest = amount * monthlyRate * termMonths
  const finalPayment = amount + totalInterest

  /** @type {PaymentRow[]} */
  const schedule = []

  for (let month = 1; month <= termMonths; month += 1) {
    const payment = month === termMonths ? finalPayment : 0
    const interest = month === termMonths ? totalInterest : 0
    const principal = month === termMonths ? amount : 0
    const remainingPrincipal = month === termMonths ? 0 : amount

    schedule.push({
      month,
      payment,
      principal,
      interest,
      remainingPrincipal
    })
  }

  const totals = {
    interest: totalInterest,
    principal: amount,
    payments: finalPayment
  }

  return { schedule, totals }
}

const loanCalculators = {
  interest_only: calculateInterestOnlySchedule,
  equal_principal: calculateEqualPrincipalSchedule,
  fixed_payment: calculateFixedPaymentSchedule,
  lump_sum: calculateLumpSumSchedule
}

server.registerTool(
  'ikapitalist_calculate_loan_schedule',
  {
    title: 'Рассчитать график платежей по займу',
    description:
      'Возвращает помесячный график платежей и итоговые суммы по выбранному виду займа.',
    inputSchema: {
      loanType: loanTypeEnum,
      amount: z.number().positive(),
      termMonths: z.number().int().min(1),
      annualRate: z.number().positive().optional()
    },
    outputSchema: {
      loanType: loanTypeEnum,
      amount: z.number(),
      termMonths: z.number(),
      annualRate: z.number(),
      schedule: z.array(
        z.object({
          month: z.number().int().min(1),
          payment: z.number(),
          principal: z.number(),
          interest: z.number(),
          remainingPrincipal: z.number().min(0)
        })
      ),
      totals: z.object({
        interest: z.number(),
        principal: z.number(),
        payments: z.number()
      })
    }
  },
  async ({ loanType, amount, termMonths, annualRate }) => {
    const rate = annualRate ?? DEFAULT_ANNUAL_RATE
    const calculator = loanCalculators[loanType]

    if (!calculator) {
      return {
        content: [
          {
            type: 'text',
            text: `Вид займа "${loanType}" не поддерживается. Доступные значения: ${loanTypeEnum.options.join(', ')}.`
          }
        ],
        isError: true
      }
    }

    try {
      const { schedule, totals } = calculator(amount, termMonths, rate)
      const payload = {
        loanType,
        amount,
        termMonths,
        annualRate: rate,
        schedule,
        totals
      }

      const textLines = [
        `Тип займа: ${loanType}`,
        `Сумма займа: ${amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₸`,
        `Срок: ${termMonths} мес.`,
        `Годовая ставка: ${(rate * 100).toFixed(2)}%`,
        '',
        'Помесячный график:'
      ]

      payload.schedule.forEach((row) => {
        const payment = row.payment.toLocaleString('ru-RU', {
          maximumFractionDigits: 2
        })
        const principal = row.principal.toLocaleString('ru-RU', {
          maximumFractionDigits: 2
        })
        const interest = row.interest.toLocaleString('ru-RU', {
          maximumFractionDigits: 2
        })
        const remaining = row.remainingPrincipal.toLocaleString('ru-RU', {
          maximumFractionDigits: 2
        })
        textLines.push(
          `Месяц ${row.month}: платёж ${payment} ₸ (ОД: ${principal} ₸, %: ${interest} ₸), остаток: ${remaining} ₸`
        )
      })

      textLines.push(
        '',
        `Итого проценты: ${totals.interest.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₸`,
        `Итого основной долг: ${totals.principal.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₸`,
        `Итого платежи: ${totals.payments.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₸`
      )

      return {
        content: [
          {
            type: 'text',
            text: textLines.join('\n')
          }
        ],
        structuredContent: payload
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text:
              error instanceof Error
                ? `Не удалось рассчитать график: ${error.message}`
                : 'Не удалось рассчитать график из-за неизвестной ошибки.'
          }
        ],
        isError: true
      }
    }
  }
)

const transport = new StdioServerTransport()

server.connect(transport).catch((error) => {
  console.error('[ikapitalist-info-mcp] Не удалось запустить MCP сервер:', error)
  process.exit(1)
})

process.on('SIGINT', async () => {
  await transport.close?.()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await transport.close?.()
  process.exit(0)
})


