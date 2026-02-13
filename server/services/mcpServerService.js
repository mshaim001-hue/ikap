const path = require('path')
const fs = require('fs')
const { MCPServerStdio } = require('@openai/agents')

const DEFAULT_SECTIONS = [
  {
    section_id: 'overview',
    title: 'Обзор iKapitalist',
    content: `# Обзор iKapitalist

iKapitalist — лицензированная инвестиционная и заёмная краудфандинговая платформа, работающая с 2019 года.
Платформа помогает малому и среднему бизнесу привлекать финансирование от инвесторов на прозрачных условиях.
Инвесторы могут выдавать займы или покупать доли в компаниях, получая доходность от 24% годовых.

**Ключевые факты:**
- Запуск: 2019 год
- Лицензия AFSA-А-LA-2023-0005 (Астана, МФЦА)
- Управление инвестиционной и заёмной краудфандинговой платформой
- Возможность прямого общения инвесторов с собственниками бизнеса`,
  },
  {
    section_id: 'licensing',
    title: 'Лицензирование и регулирование',
    content: `# Лицензирование и регулирование

Платформа iKapitalist.kz зарегистрирована в юрисдикции Международного финансового центра «Астана» (МФЦА) и регулируется Управлением по финансовым услугам AFSA.

**Лицензия:**
- Номер: AFSA-A-LA-2023-0005
- Дата выдачи: 27.04.2023
- Статус: активна
- Деятельность: управление инвестиционной и заёмной краудфандинговой платформой и платформой заемного финансирования`,
  },
  {
    section_id: 'contacts',
    title: 'Контакты iKapitalist',
    content: `# Контакты iKapitalist

Адрес: Мангилик Ел, 55/21, блок С4.2, офис 265, Астана, Казахстан
Телефон: +7 700 178 00 18
Электронная почта: claims@ikapitalist.kz

Регулятор AFSA:
- Адрес: ул. Мангилик Ел 55/17, блок C3.2, Астана, Казахстан
- Телефон: +7 (7172) 64 73 71
- Email: apd@afsa.kz`,
  },
]

/**
 * Создаёт сервис для генерации кода и инициализации MCP-сервера.
 * @param {object} db - экземпляр БД
 * @param {function} getAgentSettings - (agentName) => Promise<settings>
 * @param {object} mcpState - мутабельный объект { ikapInfoMcpServer, tempMcpServerPath }
 * @param {string} [serverDir] - путь к папке server (по умолчанию родитель от __dirname)
 */
function createMcpServerService(db, getAgentSettings, mcpState, serverDir = path.join(__dirname, '..')) {
  const templatePath = path.join(serverDir, 'mcp', 'ikap-info-server.js')

  async function generateMcpServerCode() {
    try {
      const sectionsQuery = db.prepare(`
        SELECT section_id, title, content 
        FROM mcp_sections 
        ORDER BY section_id
      `)
      const dbSections = await sectionsQuery.all()

      let baseCode = ''
      if (fs.existsSync(templatePath)) {
        baseCode = fs.readFileSync(templatePath, 'utf8')
      } else {
        throw new Error('Базовый файл MCP сервера не найден')
      }

      if (dbSections.length === 0) {
        console.log('📄 Разделов в БД нет, используем базовый код')
        return baseCode
      }

      const sectionsCode = dbSections
        .map((section) => {
          const escapedContent = section.content
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\${/g, '\\${')
          return `  ${section.section_id}: \`${escapedContent}\``
        })
        .join(',\n')

      const sectionIds = dbSections.map(s => s.section_id)
      const sectionIdsCode = sectionIds.map(id => `'${id}'`).join(', ')

      const sectionsStart = baseCode.indexOf('const sections = {')
      const sectionsEnd = baseCode.indexOf('};', sectionsStart) + 2

      if (sectionsStart === -1 || sectionsEnd === 1) {
        console.warn('⚠️ Не удалось найти объект sections в базовом коде, используем базовый код')
        return baseCode
      }

      const beforeSections = baseCode.substring(0, sectionsStart)
      const afterSections = baseCode.substring(sectionsEnd)
      const newSectionsCode = `const sections = {\n${sectionsCode}\n}`

      const sectionIdsPattern = /const sectionIds = Object\.keys\(sections\)/
      const newSectionIdsCode = `const sectionIds = [${sectionIdsCode}]`

      let generatedCode = beforeSections + newSectionsCode + afterSections
      generatedCode = generatedCode.replace(sectionIdsPattern, newSectionIdsCode)

      console.log(`✅ Сгенерирован код MCP сервера с ${dbSections.length} разделами из БД`)
      return generatedCode
    } catch (error) {
      console.error('❌ Ошибка генерации кода MCP сервера:', error)
      if (fs.existsSync(templatePath)) {
        return fs.readFileSync(templatePath, 'utf8')
      }
      throw error
    }
  }

  async function initMcpServerFromDb() {
    try {
      const mcpServerCode = await generateMcpServerCode()

      const tempDir = path.join(serverDir, 'mcp', 'temp')
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }
      mcpState.tempMcpServerPath = path.join(tempDir, 'ikap-info-server.js')
      fs.writeFileSync(mcpState.tempMcpServerPath, mcpServerCode, 'utf8')
      console.log(`✅ Временный файл MCP сервера создан: ${mcpState.tempMcpServerPath}`)

      const settings = await getAgentSettings('Information Agent')
      const defaultAnnualRate = settings?.default_annual_rate || 0.3

      mcpState.ikapInfoMcpServer = new MCPServerStdio({
        command: process.execPath,
        args: [mcpState.tempMcpServerPath],
        cwd: path.dirname(mcpState.tempMcpServerPath),
        env: {
          ...process.env,
          DEFAULT_ANNUAL_RATE: String(defaultAnnualRate),
        },
        cacheToolsList: true,
      })

      await mcpState.ikapInfoMcpServer.connect()
      console.log('✅ MCP сервер информации iKapitalist запущен из БД')
      return mcpState.ikapInfoMcpServer
    } catch (error) {
      console.error('❌ Ошибка инициализации MCP сервера из БД:', error)
      mcpState.ikapInfoMcpServer = null
      return null
    }
  }

  async function initDefaultMcpSections() {
    try {
      const countQuery = db.prepare('SELECT COUNT(*) as count FROM mcp_sections')
      const countResult = await countQuery.get()
      const count = countResult?.count || 0

      if (count > 0) {
        console.log(`✅ Разделы MCP уже инициализированы (${count} разделов)`)
        return
      }

      const insertSection = db.prepare(`
        INSERT INTO mcp_sections (section_id, title, content)
        VALUES (?, ?, ?)
        ON CONFLICT (section_id) DO NOTHING
      `)

      let inserted = 0
      for (const section of DEFAULT_SECTIONS) {
        try {
          await insertSection.run(section.section_id, section.title, section.content)
          inserted++
        } catch (e) {
          // ignore conflict
        }
      }

      if (inserted > 0) {
        console.log(`✅ Инициализировано ${inserted} базовых разделов MCP`)
      }
    } catch (error) {
      console.error('❌ Ошибка инициализации базовых разделов MCP:', error)
    }
  }

  return {
    generateMcpServerCode,
    initMcpServerFromDb,
    initDefaultMcpSections,
  }
}

module.exports = {
  createMcpServerService,
}
