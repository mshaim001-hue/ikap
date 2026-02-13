'use strict'

/**
 * Сервис анализа отчётов: банковские выписки (ikap2), налоговая отчётность (ikap3), финансовая отчётность (ikap4).
 * createReportAnalysisService(deps) возвращает { runStatementsAnalysis, runTaxAnalysis, runFsAnalysis }.
 */
function createReportAnalysisService(deps) {
  const {
    db,
    getMessagesFromDB,
    normalizeFileName,
    runDocumentsOverviewAnalysis,
    USE_ONEPAGE_SERVICE,
    ONEPAGE_SERVICE_URL,
    runningStatementsSessions,
    sessionFiles,
    USE_IKAP2_FOR_STATEMENTS,
    proxyAnalysisToIkap2,
    upsertReport,
    openaiClient,
    runningTaxSessions,
    parseTaxPdfToText,
    parseTaxPdfsBatchViaHttp,
    runningFsSessions,
    USE_FINANCIAL_PDF_SERVICE,
    analyzeFinancialPdfsViaPdftopng,
  } = deps

  async function runStatementsAnalysis(sessionId) {
    // Определяем allFiles в начале для доступа в catch блоке
    let allFiles = []
    
    try {
      // Проверка гвардов, чтобы исключить двойной запуск
      if (runningStatementsSessions.has(sessionId)) {
        console.log(`⏭️ Анализ банковских выписок уже запущен для ${sessionId}, пропускаем`)
        return
      }
      runningStatementsSessions.add(sessionId)
      const _h = await getMessagesFromDB(sessionId)
      const history = Array.isArray(_h) ? _h : []
      // Если уже есть статус generating/completed, не запускаем
      const existing = await db.prepare('SELECT status FROM reports WHERE session_id = ?').get(sessionId)
      if (existing && (existing.status === 'generating' || existing.status === 'completed')) {
        console.log(`⏭️ status=${existing.status} для ${sessionId}, повторный запуск не требуется`)
        runningStatementsSessions.delete(sessionId)
        return
      }
      
      // Получаем файлы из БД вместо памяти
      const getSessionFiles = db.prepare(`
        SELECT file_id, original_name, file_size, mime_type, category, uploaded_at
        FROM files 
        WHERE session_id = ? 
        ORDER BY uploaded_at ASC
      `)
      const dbFiles = await getSessionFiles.all(sessionId)
      
      // Преобразуем в формат, совместимый со старым кодом
      allFiles = dbFiles.map(f => ({
        fileId: f.file_id,
        originalName: normalizeFileName(f.original_name),
        size: f.file_size,
        uploadedAt: f.uploaded_at,
        category: f.category
      }))

      // Асинхронно запускаем проверку комплектности документов через onepage
      if (USE_ONEPAGE_SERVICE) {
        runDocumentsOverviewAnalysis(db, normalizeFileName, ONEPAGE_SERVICE_URL, sessionId).catch(err => {
          console.error(`❌ [onepage] Ошибка фона для сессии ${sessionId}:`, err.message)
        })
      }
      // Фильтруем только банковские выписки для финансового аналитика
      const statementFiles = allFiles.filter(f => f.category === 'statements')
      
      if (statementFiles.length === 0) {
        console.log(`⚠️ Нет банковских выписок для анализа в БД`)
        runningStatementsSessions.delete(sessionId)
        return
      }
      
      console.log(`📊 Генерация отчетов для ${statementFiles.length} банковских выписок (из ${allFiles.length} файлов)...`)
      
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
      // Ищем сумму - сначала в последовательности вопрос-ответ
      for (let i = 0; i < history.length; i++) {
        const msg = history[i]
        if (msg.role === 'assistant') {
          const assistantText = typeof msg.content === 'string' 
            ? msg.content 
            : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : '')
          
          // Если агент спрашивает о сумме
          if (assistantText.match(/какую сумму|сумму.*получить/i)) {
            console.log(`✅ Найден вопрос о сумме в элементе ${i}: "${assistantText.substring(0, 100)}"`)
            // Берем следующее сообщение пользователя
            if (i + 1 < history.length && history[i + 1].role === 'user') {
              const userResponse = typeof history[i + 1].content === 'string'
                ? history[i + 1].content
                : (Array.isArray(history[i + 1].content) ? history[i + 1].content.map(c => c.text || '').join(' ') : '')
              
              // Ищем сумму в ответе пользователя
              let amountMatch = userResponse.match(/(\d+)\s*(мил|млн|миллион)/i)
              if (amountMatch) {
                amount = `${amountMatch[1]} млн KZT`
                break
              }
              
              // Ищем большие суммы в виде цифр
              amountMatch = userResponse.match(/(\d{7,})/g)
              if (amountMatch) {
                // Берем первое число >= 10 млн (7+ цифр)
                const num = parseInt(amountMatch[0])
                console.log(`💰 Найдено число: ${num}`)
                if (num >= 10000000) {
                  amount = `${num} KZT`
                  console.log(`✅ Сумма установлена: ${amount}`)
                  break
                } else {
                  console.log(`⚠️ Число ${num} меньше 10 млн, пропускаем`)
                }
              }
              
              // Ищем суммы с разделителями тысяч
              amountMatch = userResponse.match(/(\d+)\s+(\d{3})\s+(\d{3})/)
              if (amountMatch) {
                const num = parseInt(amountMatch[1] + amountMatch[2] + amountMatch[3])
                if (num >= 10000000) {
                  amount = `${num} KZT`
                  break
                }
              }
              
              // Ищем суммы с "тыс"
              amountMatch = userResponse.match(/(\d+)\s*тыс/i)
              if (amountMatch) {
                const num = parseInt(amountMatch[1]) * 1000
                if (num >= 10000000) {
                  amount = `${num} KZT`
                  break
                }
              }
            }
          }
        }
      }
      
      // Если не нашли в последовательности, пробуем по ключевым словам
      if (amount === 'не указана') {
        let amountMatch = historyText.match(/(\d+)\s*(мил|млн|миллион)/i)
        if (amountMatch) {
          amount = `${amountMatch[1]} млн KZT`
        } else {
          // Ищем большие суммы в виде цифр
          amountMatch = historyText.match(/(\d{7,})/g)
          if (amountMatch) {
            const num = parseInt(amountMatch[0])
            console.log(`💰 Fallback: найдено число: ${num}`)
            if (num >= 10000000) {
              amount = `${num} KZT`
              console.log(`✅ Fallback: сумма установлена: ${amount}`)
            } else {
              console.log(`⚠️ Fallback: число ${num} меньше 10 млн, пропускаем`)
            }
          } else {
            // Ищем суммы с разделителями тысяч
            amountMatch = historyText.match(/(\d+)\s+(\d{3})\s+(\d{3})/)
            if (amountMatch) {
              const num = parseInt(amountMatch[1] + amountMatch[2] + amountMatch[3])
              if (num >= 10000000) {
                amount = `${num} KZT`
              }
            } else {
              // Ищем суммы с "тыс"
              amountMatch = historyText.match(/(\d+)\s*тыс/i)
              if (amountMatch) {
                const num = parseInt(amountMatch[1]) * 1000
                if (num >= 10000000) {
                  amount = `${num} KZT`
                }
              }
            }
          }
        }
      }
      
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
      
      // Банковские выписки отправляются только в ikap2 (анализ не делается в ikap)
      if (statementFiles.length > 0) {
        if (!USE_IKAP2_FOR_STATEMENTS) {
          await upsertReport(sessionId, {
            status: 'error',
            reportText: 'Для анализа банковских выписок настройте IKAP2_BACKEND_URL (https://ikap2-backend-latest.onrender.com).',
            filesCount: statementFiles.length,
            filesData: JSON.stringify(statementFiles.map(f => ({ name: f.originalName, size: f.size }))),
          })
          runningStatementsSessions.delete(sessionId)
          return
        }
        console.log(`🔄 Отправляем ${statementFiles.length} банковских выписок в ikap2`)
        
        try {
          // Получаем файлы из sessionFiles (в памяти) или из БД
          const filesForIkap2 = []
          const sessionFilesData = sessionFiles.get(sessionId) || []
          
          for (const file of statementFiles) {
            let fileBuffer = null
            
            // Сначала пытаемся получить из sessionFiles (в памяти)
            const sessionFile = sessionFilesData.find(f => f.fileId === file.fileId)
            if (sessionFile && sessionFile.buffer) {
              fileBuffer = sessionFile.buffer
            } else {
              // Если нет в памяти, пытаемся получить из БД
              try {
                const getFile = db.prepare(`
                  SELECT file_data FROM files WHERE file_id = ?
                `)
                const fileInfo = await getFile.get(file.fileId)
                if (fileInfo && fileInfo.file_data) {
                  // PostgreSQL BYTEA возвращается как Buffer или строка
                  if (Buffer.isBuffer(fileInfo.file_data)) {
                    fileBuffer = fileInfo.file_data
                  } else if (typeof fileInfo.file_data === 'string') {
                    // Если это hex строка (начинается с \x)
                    if (fileInfo.file_data.startsWith('\\x')) {
                      fileBuffer = Buffer.from(fileInfo.file_data.slice(2), 'hex')
                    } else {
                      fileBuffer = Buffer.from(fileInfo.file_data, 'binary')
                    }
                  } else {
                    fileBuffer = Buffer.from(fileInfo.file_data)
                  }
                } else if (!file.fileId.startsWith('local-')) {
                  // Если fileId не локальный, пытаемся получить из OpenAI Files API
                  try {
                    const fileContent = await openaiClient.files.retrieveContent(file.fileId)
                    fileBuffer = Buffer.from(fileContent)
                  } catch (openaiError) {
                    console.warn(`⚠️ Не удалось получить файл ${file.fileId} из OpenAI:`, openaiError.message)
                  }
                }
              } catch (dbError) {
                console.warn(`⚠️ Не удалось получить файл ${file.fileId} из БД:`, dbError.message)
                // Пытаемся получить из OpenAI, если fileId не локальный
                if (!file.fileId.startsWith('local-')) {
                  try {
                    const fileContent = await openaiClient.files.retrieveContent(file.fileId)
                    fileBuffer = Buffer.from(fileContent)
                  } catch (openaiError) {
                    console.warn(`⚠️ Не удалось получить файл ${file.fileId} из OpenAI:`, openaiError.message)
                  }
                }
              }
            }
            
            if (fileBuffer) {
              filesForIkap2.push({
                buffer: fileBuffer,
                originalname: file.originalName,
                mimetype: 'application/pdf',
                size: file.size || fileBuffer.length
              })
            } else {
              console.warn(`⚠️ Не удалось получить файл ${file.fileId} (${file.originalName}) для ikap2`)
            }
          }
          
          if (filesForIkap2.length > 0) {
            // Формируем комментарий для ikap2 (используем уже извлеченные данные)
            const comment = `${bin !== 'не указан' ? `БИН: ${bin}` : ''} ${name !== 'не указано' ? `Имя: ${name}` : ''} ${email !== 'не указан' ? `Email: ${email}` : ''}`.trim()
            
            // Вызываем ikap2 для анализа
            const ikap2Result = await proxyAnalysisToIkap2(sessionId, comment || '', {}, filesForIkap2)
            
            if (ikap2Result && ikap2Result.sessionId) {
              console.log(`✅ Анализ выписок выполнен через ikap2, sessionId: ${ikap2Result.sessionId}`)
              
              // Общее число файлов по сессии (выписки + налоги + фин. отчётность)
              const fileCountRow = await db.prepare('SELECT COUNT(*) as cnt FROM files WHERE session_id = ?').get(sessionId)
              const totalFiles = (fileCountRow && fileCountRow.cnt != null) ? Number(fileCountRow.cnt) : filesForIkap2.length
              
              await upsertReport(sessionId, {
                status: ikap2Result.status || 'generating',
                reportText: null,
                reportStructured: null,
                filesCount: totalFiles,
                filesData: JSON.stringify(filesForIkap2.map(f => ({
                  name: f.originalname,
                  size: f.size,
                  mime: f.mimetype,
                }))),
                completed: null,
                comment: comment || '',
                company_bin: bin,
                amount: amount,
                term: termMonths,
                purpose: purpose || null,
                name: name,
                email: email,
                phone: phone,
              })
              
              runningStatementsSessions.delete(sessionId)
              return // Прерываем выполнение, не используем старую логику
            }
          } else {
            await upsertReport(sessionId, {
              status: 'error',
              reportText: 'Не удалось получить файлы для отправки в сервис анализа выписок (ikap2).',
              filesCount: statementFiles.length,
              filesData: JSON.stringify(statementFiles.map(f => ({ name: f.originalName, size: f.size }))),
            })
            runningStatementsSessions.delete(sessionId)
            return
          }
        } catch (ikap2Error) {
          console.error('❌ Ошибка при вызове ikap2 для анализа выписок:', ikap2Error.message)
          console.error('❌ Стек ошибки:', ikap2Error.stack)
          const errMsg = ikap2Error?.response?.data?.message || ikap2Error?.data?.message || ikap2Error.message
          await upsertReport(sessionId, {
            status: 'error',
            reportText: `Ошибка сервиса анализа выписок (ikap2): ${errMsg}`,
            filesCount: statementFiles.length,
            filesData: JSON.stringify(statementFiles.map(f => ({ name: f.originalName, size: f.size }))),
          })
          runningStatementsSessions.delete(sessionId)
          return
        }
      }
      
      // Если есть выписки, анализ делается только через ikap2 — сюда не доходим при statementFiles.length > 0
      if (statementFiles.length > 0) {
        runningStatementsSessions.delete(sessionId)
        return
      }
      
    } catch (error) {
      console.error(`❌ Ошибка генерации отчета:`, error.message)
      console.error(`❌ Стек ошибки:`, error.stack)
      
      // Если это таймаут — НЕ помечаем отчет как error, оставляем status=generating.
      // Агент мог продолжить выполнение в OpenAI, и отчет придет позже.
      if (String(error.message || '').includes('timeout')) {
        console.warn('⏳ Обработка не успела за таймаут. Статус оставлен generating, отчет может появиться позже.')
      } else {
        // Сохраняем ошибку в БД
        const updateError = db.prepare(`
          UPDATE reports 
          SET report_text = ?, status = 'error', completed_at = CURRENT_TIMESTAMP
          WHERE session_id = ?
        `)
        await updateError.run(`Ошибка генерации отчета: ${error.message}`, sessionId)
      }
    } finally {
      runningStatementsSessions.delete(sessionId)
    }
  }

  async function runTaxAnalysis(sessionId) {
try {
    // Проверка гвардов, чтобы исключить двойной запуск
    if (runningTaxSessions.has(sessionId)) {
      console.log(`⏭️ Налоговый анализ уже запущен для ${sessionId}, пропускаем`)
      return
    }
    runningTaxSessions.add(sessionId)
    
    // Если уже есть статус generating/completed, не запускаем
    const existing = await db.prepare('SELECT tax_status FROM reports WHERE session_id = ?').get(sessionId)
    if (existing && (existing.tax_status === 'generating' || existing.tax_status === 'completed')) {
      console.log(`⏭️ tax_status=${existing.tax_status} для ${sessionId}, повторный запуск не требуется`)
      runningTaxSessions.delete(sessionId)
      return
    }
    
    // Собираем файлы налоговой отчетности
    const taxFilesRows = await db.prepare(`
      SELECT file_id, original_name, uploaded_at FROM files WHERE session_id = ? AND category = 'taxes' ORDER BY uploaded_at ASC
    `).all(sessionId)
    const taxFilesRowsWithNames = (taxFilesRows || []).map(r => ({
      ...r,
      normalized_name: normalizeFileName(r.original_name || '')
    }))
    const taxFileIds = taxFilesRowsWithNames.map(r => r.file_id)
    const taxYearsMissing = []
    // Простая проверка покрытия двух лет по именам файлов
    const yearNow = new Date().getFullYear()
    const names = taxFilesRowsWithNames.map(r => r.normalized_name.toLowerCase())
    if (!names.some(n => n.includes(String(yearNow)))) taxYearsMissing.push(String(yearNow))
    if (!names.some(n => n.includes(String(yearNow - 1)))) taxYearsMissing.push(String(yearNow - 1))
    
    await db.prepare(`UPDATE reports SET tax_status = 'generating', tax_missing_periods = ? WHERE session_id = ?`).run(
      taxYearsMissing.length ? taxYearsMissing.join(',') : null, sessionId
    )
    
    if (taxFileIds.length > 0) {
      const TAX_TIMEOUT_MS = 40 * 60 * 1000 // 40 минут на анализ
      
      // Получаем файлы из sessionFiles для парсинга
      const sessionFilesData = sessionFiles.get(sessionId) || []
      
      // Преобразуем в удобный формат с проверкой наличия buffer в памяти
      const taxFiles = taxFilesRowsWithNames.map(r => {
        const sessionFile = sessionFilesData.find(f => f.fileId === r.file_id)
        return {
          fileId: r.file_id,
          originalName: r.normalized_name,
          buffer: sessionFile?.buffer || null, // Используем buffer из памяти, если есть
          mimetype: sessionFile?.mimetype || 'application/pdf'
        }
      })
      
      console.log(`\n📄 Начинаем парсинг ${taxFiles.length} налоговых PDF файлов в TXT...`)

      const USE_TAX_PDF_SERVICE_HTTP = !!process.env.TAX_PDF_SERVICE_URL

      // Получить buffer для одного налогового файла (память → БД → OpenAI)
      const getBufferForTaxFile = async (file) => {
        if (file.buffer && Buffer.isBuffer(file.buffer)) {
          return file.buffer
        }
        let foundInDB = false
        let pdfBuffer = null
        try {
          const fileInfo = await db.prepare('SELECT file_data FROM files WHERE file_id = ?').get(file.fileId)
          if (fileInfo && fileInfo.file_data) {
            if (Buffer.isBuffer(fileInfo.file_data)) pdfBuffer = fileInfo.file_data
            else if (typeof fileInfo.file_data === 'string') {
              pdfBuffer = fileInfo.file_data.startsWith('\\x')
                ? Buffer.from(fileInfo.file_data.slice(2), 'hex')
                : Buffer.from(fileInfo.file_data, 'binary')
            } else pdfBuffer = Buffer.from(fileInfo.file_data)
            foundInDB = true
          }
        } catch (e) { /* ignore */ }
        if (!foundInDB && !file.fileId.startsWith('local-')) {
          const pdfFileContent = await openaiClient.files.content(file.fileId)
          pdfBuffer = Buffer.from(await pdfFileContent.arrayBuffer())
        } else if (!pdfBuffer) {
          throw new Error(`Файл не найден: ${file.fileId}`)
        }
        return pdfBuffer
      }

      let parsedTexts = []
      let parseErrors = []

      if (USE_TAX_PDF_SERVICE_HTTP && taxFiles.length > 0) {
        // Один запрос в ikap3 на всю заявку — один анализ в списке сервиса
        const resolved = await Promise.allSettled(
          taxFiles.map(async (file) => ({
            buffer: await getBufferForTaxFile(file),
            filename: file.originalName
          }))
        )
        const batchFiles = resolved
          .filter(r => r.status === 'fulfilled' && r.value && r.value.buffer)
          .map(r => r.value)
        parseErrors = resolved
          .filter(r => r.status === 'rejected')
          .map(r => `Ошибка получения файла: ${r.reason?.message || 'Неизвестная ошибка'}`)

        if (batchFiles.length > 0) {
          console.log(`📤 Один батч-запрос в ikap3 (taxpdfto): ${batchFiles.length} файлов`)
          try {
            const batchResult = await parseTaxPdfsBatchViaHttp(batchFiles, true)

            // ✅ Основной путь: используем итоговый анализ от ikap3 (analysis_text),
            // который совпадает с тем, что отображается в UI taxpdfto.
            if (batchResult && typeof batchResult.analysis_text === 'string' && batchResult.analysis_text.trim()) {
              let aiAnalysis = batchResult.analysis_text.trim()

              // Нормализуем markdown-таблицы:
              // 1) добавляем перевод строки между заголовком и строкой-разделителем, если они слиплись;
              // 2) убираем пустые строки между строками таблицы, чтобы строки шли подряд.
              aiAnalysis = aiAnalysis.replace(
                /(\|[^\n]+?\|)\s*(\|[-:\s|]+\|)/g,
                '$1\n$2'
              )
              aiAnalysis = aiAnalysis.replace(
                /\n(\|[^\n]+\|)\n\n(?=\|[^\n]+\|)/g,
                '\n$1\n'
              )

              console.log(`📊 Получен итоговый налоговый анализ от ikap3 (длина: ${aiAnalysis.length} символов после нормализации)`)

              try {
                await db.prepare(`
                  UPDATE reports
                  SET tax_report_text = ?, tax_status = 'completed'
                  WHERE session_id = ?
                `).run(aiAnalysis, sessionId)
                console.log('✅ Налоговый отчет (analysis_text) сохранен в БД')
              } catch (dbError) {
                console.error('❌ Ошибка сохранения налогового отчета (analysis_text) в БД:', dbError.message)
              }

              // История и структурированные данные уже сохранены в taxpdfto (ikap3),
              // поэтому здесь можно завершить налоговый анализ для данной сессии.
              return
            }

            // Fallback: старый путь через per-file analysis, если analysis_text отсутствует
            const files = Array.isArray(batchResult.files) ? batchResult.files : []
            parsedTexts = files.map((f) => ({
              fileName: f.filename || f.fileName || 'document.pdf',
              text: f.text || '',
              analysis: f.analysis || null
            }))
            parsedTexts.forEach((item) => {
              if (item.analysis) {
                console.log(`✅ Анализ от taxpdfto для "${item.fileName}": ${item.analysis.length} символов`)
              }
            })
          } catch (batchErr) {
            parseErrors.push(`Батч-запрос к ikap3: ${batchErr.message}`)
            console.error('❌ Батч taxpdfto:', batchErr.message)
          }
        }
      } else {
        // Пофайловый парсинг (локальный Python или fallback)
        const parseSingleTaxFile = async (file) => {
          console.log(`🔄 Парсим PDF: ${file.originalName}`)
          const pdfBuffer = await getBufferForTaxFile(file)
          const parseResult = await parseTaxPdfToText(pdfBuffer, file.originalName, false)
          if (!parseResult?.text?.trim()) throw new Error('Парсинг PDF вернул пустой текст')
          const result = { fileName: file.originalName, text: parseResult.text }
          if (parseResult.analysis) result.analysis = parseResult.analysis
          return result
        }
        const TAX_BATCH_SIZE = 5
        const runBatch = (batch) => Promise.allSettled(batch.map(file => parseSingleTaxFile(file)))
        const parseResults = []
        for (let i = 0; i < taxFiles.length; i += TAX_BATCH_SIZE) {
          const batchResults = await runBatch(taxFiles.slice(i, i + TAX_BATCH_SIZE))
          parseResults.push(...batchResults)
        }
        parseResults.forEach((result, index) => {
          if (result.status === 'fulfilled') parsedTexts.push(result.value)
          else parseErrors.push(`Ошибка парсинга файла "${taxFiles[index].originalName}": ${result.reason?.message || 'Неизвестная ошибка'}`)
        })
      }
      
      if (parsedTexts.length === 0) {
        const errorMessage = 'Нет файлов для анализа'
        await db.prepare(`UPDATE reports SET tax_status = 'error', tax_report_text = ? WHERE session_id = ?`).run(errorMessage, sessionId)
        console.error(`❌ ${errorMessage}`)
        return
      }
      
      if (parseErrors.length > 0) {
        const warningMessage = `Не удалось распарсить некоторые PDF файлы (анализ выполняется по успешно распарсенным):\n${parseErrors.join('\n')}`
        console.warn(`⚠️ ${warningMessage}`)
      }
      
      console.log(`✅ Успешно распарсены ${parsedTexts.length} PDF файлов из ${taxFiles.length}`)

      // Проверяем, есть ли готовые анализы от taxpdfto
      const hasReadyAnalyses = parsedTexts.some(item => item.analysis)
      
      let combinedTaxReport = ''
      const analysisErrors = []

      if (hasReadyAnalyses) {
        // Если есть готовые анализы от taxpdfto, используем их
        console.log(`📊 Используем готовые анализы от taxpdfto`)
        
        for (let i = 0; i < parsedTexts.length; i += 1) {
          const item = parsedTexts[i]
          
          if (item.analysis) {
            // Добавляем анализ с разделителем
            combinedTaxReport += `\n${'='.repeat(80)}\nОТЧЕТ ${i + 1} ИЗ ${parsedTexts.length}\nФайл: ${item.fileName}\n${'='.repeat(80)}\n\n`
            combinedTaxReport += item.analysis.trim()
            combinedTaxReport += '\n\n'
            console.log(`✅ Добавлен анализ для файла "${item.fileName}"`)
          } else {
            // Если для файла нет анализа, добавляем предупреждение
            const warning = `⚠️ Анализ для файла "${item.fileName}" не был получен от taxpdfto`
            analysisErrors.push(warning)
            console.warn(warning)
          }
        }
      } else {
        // Налоговый анализ делается только через ikap3 (taxpdfto). Агенты в ikap не используются.
        const errMsg = process.env.TAX_PDF_SERVICE_URL
          ? 'Сервис налоговых деклараций (ikap3) не вернул анализ. Убедитесь, что TAX_PDF_SERVICE_URL указывает на https://ikap3-backend-latest.onrender.com и сервис доступен.'
          : 'Для анализа налоговых деклараций настройте TAX_PDF_SERVICE_URL (https://ikap3-backend-latest.onrender.com).'
        console.error(`❌ ${errMsg}`)
        try {
          await db.prepare(`UPDATE reports SET tax_status = 'error', tax_report_text = ? WHERE session_id = ?`).run(errMsg, sessionId)
        } catch (dbError) {
          console.error(`❌ Ошибка сохранения статуса ошибки в БД:`, dbError.message)
        }
        return
      }

      if (!combinedTaxReport) {
        const errorMessage = `Ошибка анализа: ни один из батчей не был успешно обработан. Ошибки: ${analysisErrors.join(' | ')}`
        console.error(`❌ ${errorMessage}`)
        try {
          await db.prepare(`UPDATE reports SET tax_status = 'error', tax_report_text = ? WHERE session_id = ?`).run(errorMessage, sessionId)
        } catch (dbError) {
          console.error(`❌ Ошибка сохранения статуса ошибки в БД:`, dbError.message)
        }
        return
      }

      // Если были ошибки парсинга или анализа отдельных батчей - добавляем их в конец отчета
      if (parseErrors.length > 0 || analysisErrors.length > 0) {
        combinedTaxReport += `\n\n${'='.repeat(80)}\n⚠️ ДОПОЛНИТЕЛЬНАЯ ИНФОРМАЦИЯ\n${'='.repeat(80)}\n`
        if (parseErrors.length > 0) {
          combinedTaxReport += `\nФАЙЛЫ С ОШИБКАМИ ПРИ ПАРСИНГЕ:\n${parseErrors.join('\n')}\n`
        }
        if (analysisErrors.length > 0) {
          combinedTaxReport += `\nБАТЧИ С ОШИБКАМИ ПРИ АНАЛИЗЕ:\n${analysisErrors.join('\n')}\n`
        }
      }

      console.log(`✅ Анализ налоговых файлов завершен для всех батчей`)
      console.log(`📄 Размер итогового отчета: ${combinedTaxReport.length} символов`)
      if (combinedTaxReport.length > 0) {
        const preview = combinedTaxReport.substring(0, 200).replace(/\n/g, ' ')
        console.log(`📋 Превью отчета: ${preview}...`)
      }

      // Сохраняем объединенный отчет в БД
      console.log(`💾 Сохраняем налоговый отчет в БД...`)
      try {
        await db.prepare(`UPDATE reports SET tax_report_text = ?, tax_status = 'completed' WHERE session_id = ?`).run(combinedTaxReport, sessionId)
        console.log(`✅ Налоговый отчет сохранен для ${parsedTexts.length} файлов`)
      } catch (dbError) {
        console.error(`❌ Ошибка сохранения налогового отчета в БД:`, dbError.message)
        // Пробуем еще раз через небольшую задержку
        await new Promise((resolve) => setTimeout(resolve, 500))
        try {
          await db.prepare(`UPDATE reports SET tax_report_text = ?, tax_status = 'completed' WHERE session_id = ?`).run(combinedTaxReport, sessionId)
          console.log(`✅ Налоговый отчет сохранен после retry`)
        } catch (retryError) {
          console.error(`❌ Ошибка сохранения после retry:`, retryError.message)
          // Продолжаем работу, отчет все равно будет доступен в памяти
        }
      }
    } else {
      try {
        await db.prepare(`UPDATE reports SET tax_status = 'error', tax_report_text = 'Файлы налоговой отчетности не найдены' WHERE session_id = ?`).run(sessionId)
      } catch (dbError) {
        console.error(`❌ Ошибка сохранения статуса ошибки в БД:`, dbError.message)
      }
    }
          } catch (e) {
    console.error('❌ Ошибка запуска налогового анализа:', e)
          } finally {
    runningTaxSessions.delete(sessionId)
          }
  }

  async function runFsAnalysis(sessionId) {
try {
    if (runningFsSessions.has(sessionId)) {
      console.log(`⏭️ Фин. анализ уже запущен для ${sessionId}, пропускаем`)
      return
    }
    runningFsSessions.add(sessionId)
    const existing = await db.prepare('SELECT fs_status FROM reports WHERE session_id = ?').get(sessionId)
    if (existing && (existing.fs_status === 'generating' || existing.fs_status === 'completed')) {
      console.log(`⏭️ fs_status=${existing.fs_status} для ${sessionId}, повторный запуск не требуется`)
      runningFsSessions.delete(sessionId)
      return
    }
    // Собираем файлы финансовой отчетности
    const fsFilesRows = await db.prepare(`
      SELECT file_id, original_name, uploaded_at FROM files WHERE session_id = ? AND category = 'financial' ORDER BY uploaded_at ASC
    `).all(sessionId)
    const fsFilesRowsWithNames = (fsFilesRows || []).map(r => ({
      ...r,
      normalized_name: normalizeFileName(r.original_name || '')
    }))
    const fsFileIds = fsFilesRowsWithNames.map(r => r.file_id)
    const fsYearsMissing = []
    const yearNow = new Date().getFullYear()
    const names = fsFilesRowsWithNames.map(r => r.normalized_name.toLowerCase())
    if (!names.some(n => n.includes(String(yearNow)))) fsYearsMissing.push(String(yearNow))
    if (!names.some(n => n.includes(String(yearNow - 1)))) fsYearsMissing.push(String(yearNow - 1))
    await db.prepare(`UPDATE reports SET fs_status = 'generating', fs_missing_periods = ? WHERE session_id = ?`).run(
      fsYearsMissing.length ? fsYearsMissing.join(',') : null, sessionId
    )
    
    // Фильтруем только PDF файлы (XLSX больше не поддерживаются)
    const pdfFiles = fsFilesRowsWithNames.filter(f => {
      const name = f.normalized_name.toLowerCase()
      return name.endsWith('.pdf')
    })
    const nonPdfFiles = fsFilesRowsWithNames.filter(f => {
      const name = f.normalized_name.toLowerCase()
      return !name.endsWith('.pdf')
    })
    
    const fsFileReports = [] // Массив отчетов для всех файлов
    // ВАЖНО: Эти переменные должны быть видимы в блоке сохранения отчёта ниже,
    // иначе при отсутствии PDF получим ReferenceError.
    let fsTable = []
    let fsYears = []
    let fsSummary = ''
    
    // Обрабатываем PDF файлы через ikap4 (pdftopng)
    if (pdfFiles.length > 0) {
      const sessionFilesData = sessionFiles.get(sessionId) || []
      const pdfFilesWithBuffers = pdfFiles
        .map(pdfFile => {
          const sessionFile = sessionFilesData.find(f => f.fileId === pdfFile.file_id)
          if (sessionFile && sessionFile.buffer) {
            return {
              buffer: sessionFile.buffer,
              originalName: pdfFile.normalized_name,
              fileId: pdfFile.file_id
            }
          }
          return null
        })
        .filter(Boolean)

      // Финансовая отчётность отправляется только в ikap4 (pdftopng). Агенты в ikap не используются.
      if (USE_FINANCIAL_PDF_SERVICE && pdfFilesWithBuffers.length > 0) {
        console.log(`\n📄 Отправляем ${pdfFilesWithBuffers.length} PDF на ikap4 (pdftopng, фин. отчётность)...`)
        try {
          const { report, table, years, summary } = await analyzeFinancialPdfsViaPdftopng(pdfFilesWithBuffers)
          fsTable = table || []
          fsYears = years || []
          fsSummary = summary || ''

          // Формируем один общий отчёт по всем PDF, как в интерфейсе ikap4
          const combinedName = pdfFilesWithBuffers.length === 1
            ? pdfFilesWithBuffers[0].originalName
            : `Отчёт (${pdfFilesWithBuffers.length} файлов): ${pdfFilesWithBuffers.map(f => f.originalName).join(', ')}`

          fsFileReports.push({
            fileId: pdfFilesWithBuffers[0].fileId,
            fileName: combinedName,
            report
          })
        } catch (err) {
          console.error(`❌ Ошибка ikap4 (pdftopng):`, err.message)
          pdfFilesWithBuffers.forEach(f => {
            fsFileReports.push({
              fileId: f.fileId,
              fileName: f.originalName,
              report: `Ошибка анализа через ikap4 (pdftopng): ${err.message}`
            })
          })
        }
      } else {
        const errMsg = !USE_FINANCIAL_PDF_SERVICE
          ? 'Для анализа финансовой отчётности настройте FINANCIAL_PDF_SERVICE_URL (https://ikap4-backend.onrender.com).'
          : 'Buffer файлов не найден для обработки'
        console.error(`❌ ${errMsg}`)
        pdfFiles.forEach(pdfFile => {
          fsFileReports.push({
            fileId: pdfFile.file_id,
            fileName: pdfFile.normalized_name,
            report: `Ошибка: ${errMsg}`
          })
        })
      }
    }
    
    // Сохраняем объединенный отчет (только PDF)
    if (fsFileReports.length > 0) {
      let combinedFsReport
      if (fsFileReports.length === 1) {
        // Обычный сценарий: один общий отчёт по нескольким файлам
        const fr = fsFileReports[0]
        combinedFsReport = `\n\n${'='.repeat(80)}\nОТЧЕТ 1 из 1\nФайл: ${fr.fileName}\n${'='.repeat(80)}\n\n${fr.report}`
      } else {
        // Редкий сценарий с ошибками по отдельным файлам — сохраняем по-старому, чтобы видеть, что упало
        combinedFsReport = fsFileReports.map((fr, idx) => {
          return `\n\n${'='.repeat(80)}\nОТЧЕТ ${idx + 1} из ${fsFileReports.length}\nФайл: ${fr.fileName}\n${'='.repeat(80)}\n\n${fr.report}`
        }).join('\n\n')
      }

      // Нормализуем markdown-таблицы в текстовом отчете (для совместимости),
      // но основной источник таблицы для фронта — это fs_report_structured (JSON).
      combinedFsReport = combinedFsReport.replace(
        /(\|[^\n]+?\|)\s*(\|[-:\s|]+\|)/g,
        '$1\n$2'
      )
      combinedFsReport = combinedFsReport.replace(
        /\n(\|[^\n]+\|)\n\n(?=\|[^\n]+\|)/g,
        '\n$1\n'
      )
      
      if (nonPdfFiles.length > 0) {
        const nonPdfNames = nonPdfFiles.map(f => f.normalized_name).join(', ')
        combinedFsReport += `\n\n⚠️ Файлы некорректного формата (не проанализированы): ${nonPdfNames}. Для автоматического анализа требуется формат PDF.`
      }
      
      // Сохраняем объединенный отчет в БД
      console.log(`💾 Сохраняем ${fsFileReports.length} финансовых отчетов в БД...`)
      let fsStructured = null
      try {
        fsStructured = JSON.stringify({ table: fsTable, years: fsYears, summary: fsSummary })
      } catch (e) {
        console.warn('⚠️ Не удалось сериализовать fs_report_structured:', e.message)
      }
      await db.prepare(`UPDATE reports SET fs_report_text = ?, fs_report_structured = ?, fs_status = 'completed' WHERE session_id = ?`).run(
        combinedFsReport,
        fsStructured,
        sessionId
      )
      console.log(`✅ Финансовые отчеты сгенерированы для всех ${fsFileReports.length} файлов`)
    } else if (fsFileIds.length > 0) {
      // Есть файлы, но не удалось их обработать
      const allFileNames = fsFilesRowsWithNames.map(f => f.normalized_name).join(', ')
      const pdfFileNames = pdfFiles.map(f => f.normalized_name).join(', ')
      const nonPdfFileNames = nonPdfFiles.map(f => f.normalized_name).join(', ')
      
      let errorMessage = ''
      if (pdfFiles.length > 0 && nonPdfFiles.length > 0) {
        errorMessage = `Не удалось обработать PDF файлы: ${pdfFileNames}. Также найдены файлы некорректного формата: ${nonPdfFileNames}. Для автоматического анализа требуется формат PDF.`
      } else if (pdfFiles.length > 0) {
        errorMessage = `Не удалось обработать файлы финансовой отчетности: ${pdfFileNames}. Проверьте формат файлов (требуется PDF).`
      } else {
        errorMessage = `Файлы некорректного формата: ${nonPdfFileNames}. Для автоматического анализа требуется формат PDF.`
      }
      
      await db.prepare(`UPDATE reports SET fs_status = 'error', fs_report_text = ? WHERE session_id = ?`).run(
        errorMessage,
        sessionId
      )
    } else {
      await db.prepare(`UPDATE reports SET fs_status = 'error', fs_report_text = 'Файлы финансовой отчетности не найдены' WHERE session_id = ?`).run(sessionId)
    }
          } catch (e) {
    console.error('❌ Ошибка запуска анализа фин. отчетности:', e)
          } finally {
    runningFsSessions.delete(sessionId)
          }
  }

  return { runStatementsAnalysis, runTaxAnalysis, runFsAnalysis }
}

module.exports = { createReportAnalysisService }
