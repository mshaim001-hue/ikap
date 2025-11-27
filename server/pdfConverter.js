/**
 * Модуль для конвертации PDF выписок в JSON через Python-сервис
 * Использует алгоритм из /Users/mshaimard/pdf
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { promisify } = require('util')

const writeFile = promisify(fs.writeFile)
const unlink = promisify(fs.unlink)
const mkdir = promisify(fs.mkdir)

// Путь к Python-сервису конвертации
// Структура проекта: server/ и pdf/ находятся в корне проекта
// В Docker: __dirname = /app/server, process.cwd() = /app, значит pdf/ в /app/pdf
// На Render.com (без Docker): process.cwd() = /opt/render/project/src, значит pdf/ в process.cwd()/pdf
// Локально: __dirname = .../server, значит pdf/ в __dirname/../pdf
const PDF_SERVICE_PATH = process.env.PDF_SERVICE_PATH || 
  (process.env.NODE_ENV === 'production' 
    ? (__dirname.startsWith('/app/') ? '/app/pdf' : path.join(process.cwd(), 'pdf'))  // Docker или Render.com
    : path.join(__dirname, '..', 'pdf'))  // Локально: относительно server/
const PDF_SERVICE_PORT = process.env.PDF_SERVICE_PORT || 8000
const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL || `http://localhost:${PDF_SERVICE_PORT}`

/**
 * Конвертирует PDF файл в JSON через Python-сервис
 * @param {Buffer} pdfBuffer - Байты PDF файла
 * @param {string} filename - Имя файла
 * @returns {Promise<Array>} Массив с результатами конвертации
 */
async function convertPdfToJson(pdfBuffer, filename) {
  // Вариант 1: Вызов через HTTP (если сервис запущен)
  if (process.env.USE_PDF_SERVICE_HTTP === 'true' || process.env.USE_PDF_SERVICE_HTTP === '1') {
    return convertPdfToJsonViaHttp(pdfBuffer, filename)
  }
  
  // Вариант 2: Прямой вызов Python скрипта
  return convertPdfToJsonViaPython(pdfBuffer, filename)
}

/**
 * Конвертация через HTTP запрос к Python-сервису
 */
async function convertPdfToJsonViaHttp(pdfBuffer, filename) {
  const FormData = require('form-data')
  const axios = require('axios')
  
  const formData = new FormData()
  formData.append('files', pdfBuffer, {
    filename: filename,
    contentType: 'application/pdf'
  })

  try {
    const response = await axios.post(`${PDF_SERVICE_URL}/process`, formData, {
      headers: formData.getHeaders(),
      timeout: 300000, // 5 минут таймаут для больших файлов
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    })

    if (response.status === 204) {
      // Нет строк с кредитом
      return []
    }

    return Array.isArray(response.data) ? response.data : [response.data]
  } catch (error) {
    console.error('❌ Ошибка HTTP запроса к PDF-сервису:', error.message)
    if (error.response) {
      console.error('Response status:', error.response.status)
      console.error('Response data:', error.response.data)
    }
    throw new Error(`Не удалось конвертировать PDF через HTTP: ${error.message}`)
  }
}

/**
 * Конвертация через прямой вызов Python скрипта
 */
async function convertPdfToJsonViaPython(pdfBuffer, filename, customPdfServicePath = null) {
  const tempDir = path.join(__dirname, 'temp')
  const tempPdfPath = path.join(tempDir, `pdf_${Date.now()}_${filename}`)
  
  try {
    // Создаем временную директорию, если её нет
    if (!fs.existsSync(tempDir)) {
      await mkdir(tempDir, { recursive: true })
    }

    // Сохраняем PDF во временный файл
    await writeFile(tempPdfPath, pdfBuffer)

    // Вызываем Python скрипт для конвертации
    // Используем заданный путь - мы знаем структуру проекта
    let servicePath = customPdfServicePath || PDF_SERVICE_PATH
    
    // Если мы в Docker (__dirname начинается с /app/), ВСЕГДА используем /app/pdf
    if (__dirname.startsWith('/app/') && !customPdfServicePath) {
      servicePath = '/app/pdf'
    }
    
    // Если путь абсолютный - используем как есть, иначе разрешаем относительно process.cwd()
    const resolvedPdfServicePath = path.isAbsolute(servicePath) 
      ? servicePath 
      : path.resolve(process.cwd(), servicePath)
    const pythonScript = path.join(resolvedPdfServicePath, 'app', 'cli.py')
    const pythonExecutable = process.env.PYTHON_PATH || 'python3'
    
    // Проверяем существование файла
    if (!fs.existsSync(pythonScript)) {
      console.error(`❌ Python скрипт не найден: ${pythonScript}`)
      console.warn(`⚠️ Продолжаем без конвертации банковских выписок в JSON`)
      
      // Удаляем временный файл
      try {
        if (fs.existsSync(tempPdfPath)) {
          await unlink(tempPdfPath)
        }
      } catch (err) {
        // Игнорируем ошибку удаления
      }
      // Возвращаем пустой массив, чтобы система продолжала работу
      return []
    }

    return new Promise((resolve, reject) => {
      // Проверяем, есть ли виртуальное окружение (для локальной разработки)
      const venvPython = path.join(resolvedPdfServicePath, 'venv', 'bin', 'python3')
      const venvPythonAlt = path.join(resolvedPdfServicePath, 'venv', 'bin', 'python')
      const venvExists = fs.existsSync(venvPython) || fs.existsSync(venvPythonAlt)
      
      let actualPythonExecutable = pythonExecutable
      let pythonEnv = { ...process.env, PYTHONUNBUFFERED: '1' }
      
      // Функция для запуска Python процесса конвертации
      const runPythonConversion = () => {
        // Запускаем как модуль, чтобы относительные импорты работали
        const pythonProcess = spawn(actualPythonExecutable, ['-m', 'app.cli', tempPdfPath, '--json'], {
          cwd: resolvedPdfServicePath,
          env: pythonEnv
        })

        let stdout = ''
        let stderr = ''

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        pythonProcess.on('close', async (code) => {
          // Удаляем временный файл
          try {
            await unlink(tempPdfPath)
          } catch (err) {
            // Игнорируем ошибку удаления
          }

          if (code !== 0) {
            console.error(`❌ Ошибка конвертации файла ${filename}: Python скрипт завершился с кодом ${code}`)
            reject(new Error(`Python скрипт завершился с кодом ${code}: ${stderr || stdout}`))
            return
          }

          try {
            // Проверяем, есть ли сообщение об отсутствии транзакций
            const stdoutTrimmed = stdout.trim()
            if (stdoutTrimmed === '' || stdoutTrimmed.includes('No credit rows found')) {
              // Возвращаем пустой результат
              resolve([{
                source_file: filename,
                metadata: {},
                transactions: [],
                error: 'Не найдено операций по кредиту в PDF файле'
              }])
              return
            }

            // Python скрипт может выводить логи в stdout перед и после JSON
            // Ищем JSON блок в stdout (обычно это последний блок, начинающийся с [ или {)
            let jsonString = stdoutTrimmed
            
            // Пытаемся найти JSON блок - ищем последний блок, начинающийся с [ или {
            // Python скрипт всегда возвращает массив, поэтому ищем последний [
            const jsonStartIndex = stdoutTrimmed.lastIndexOf('[')
            
            // Если не нашли [, ищем {
            const jsonStartIndexBrace = jsonStartIndex >= 0 ? jsonStartIndex : stdoutTrimmed.lastIndexOf('{')
            
            if (jsonStartIndex >= 0 || jsonStartIndexBrace >= 0) {
              const actualStartIndex = jsonStartIndex >= 0 ? jsonStartIndex : jsonStartIndexBrace
              // Найден JSON блок, извлекаем его
              let extractedJson = stdoutTrimmed.substring(actualStartIndex)
              
              // Находим конец JSON, пробуя парсить с конца строки
              // Уменьшаем длину строки, пока не получим валидный JSON
              let jsonEndIndex = extractedJson.length
              let foundValidJson = false
              let jsonString = null  // Будет установлен при успешном извлечении
              
              // Пробуем найти конец JSON, начиная с конца строки
              // Ищем закрывающую скобку/квадратную скобку, которая завершает JSON
              // Важно: если JSON начинается с [, он должен заканчиваться на ]
              const startsWithBracket = extractedJson.trim().startsWith('[')
              
              // Сначала пробуем найти правильный конец JSON, используя подсчет скобок
              // Это более надежный способ для вложенных структур
              if (startsWithBracket) {
                let bracketCount = 0
                let jsonEnd = -1
                
                for (let i = 0; i < extractedJson.length; i++) {
                  const char = extractedJson[i]
                  if (char === '[') {
                    bracketCount++
                  } else if (char === ']') {
                    bracketCount--
                    if (bracketCount === 0) {
                      // Нашли закрывающую скобку, соответствующую открывающей
                      jsonEnd = i + 1
                      break
                    }
                  }
                }
                
                if (jsonEnd > 0) {
                  const testJson = extractedJson.substring(0, jsonEnd).trim()
                  try {
                    const parsed = JSON.parse(testJson)
                    if (Array.isArray(parsed) && parsed.length > 0) {
                      const firstItem = parsed[0]
                      if (firstItem && typeof firstItem === 'object') {
                        const hasSourceFile = 'source_file' in firstItem
                        const hasTransactions = 'transactions' in firstItem
                        const hasTransactionKeys = 'page_number' in firstItem || 'Дата' in firstItem || 'Кредит' in firstItem
                        
                        // Если это документ с правильной структурой
                        if ((hasSourceFile || hasTransactions) && !(hasTransactionKeys && !hasSourceFile && !hasTransactions)) {
                          jsonString = testJson
                          foundValidJson = true
                        }
                      }
                    }
                  } catch (e) {
                    // Если не получилось через подсчет скобок, используем старый метод
                  }
                }
              }
              
              // Если не нашли через подсчет скобок, используем старый метод
              if (!foundValidJson) {
                for (let i = extractedJson.length; i > 0; i--) {
                  const testJson = extractedJson.substring(0, i).trim()
                  if (testJson.length === 0) continue
                  
                  // Проверяем, что строка заканчивается на ] или }
                  const lastChar = testJson[testJson.length - 1]
                  
                  // Если JSON начинается с [, он должен заканчиваться на ]
                  if (startsWithBracket && lastChar !== ']') continue
                  if (!startsWithBracket && lastChar !== ']' && lastChar !== '}') continue
                  
                  try {
                    // Пробуем распарсить - если успешно, значит это валидный JSON
                    const parsed = JSON.parse(testJson)
                    
                    // Дополнительная проверка: если это массив, проверяем структуру первого элемента
                    if (Array.isArray(parsed)) {
                      if (parsed.length > 0) {
                        const firstItem = parsed[0]
                        // Проверяем, что это документ (имеет source_file или transactions), а не транзакция
                        if (firstItem && typeof firstItem === 'object') {
                          const hasSourceFile = 'source_file' in firstItem
                          const hasTransactions = 'transactions' in firstItem
                          const hasTransactionKeys = 'page_number' in firstItem || 'Дата' in firstItem || 'Кредит' in firstItem
                          
                          // Если это транзакция (имеет ключи транзакции, но нет source_file и transactions), это неправильно
                          if (hasTransactionKeys && !hasSourceFile && !hasTransactions) {
                            // Это транзакция, а не документ - продолжаем искать
                            continue
                          }
                          
                          // Если это документ с транзакциями - это правильный JSON
                          if (hasSourceFile || hasTransactions) {
                            console.log(`✅ Найден правильный JSON: массив с документом (source_file: ${hasSourceFile}, transactions: ${hasTransactions ? parsed[0].transactions?.length : 0})`)
                            jsonEndIndex = i
                            foundValidJson = true
                            break
                          }
                        }
                      } else {
                        // Пустой массив - это тоже валидный JSON, но не то, что нам нужно
                        continue
                      }
                    } else {
                      // Это не массив - продолжаем искать
                      continue
                    }
                  } catch (e) {
                    // Продолжаем искать
                    continue
                  }
                }
              }
              
              if (foundValidJson) {
                // Если jsonString еще не установлен (через подсчет скобок), устанавливаем его
                if (!jsonString) {
                  jsonString = extractedJson.substring(0, jsonEndIndex).trim()
                }
                const jsonLength = jsonString.length
                console.log(`📝 Извлечен JSON из stdout (пропущено ${actualStartIndex} символов до JSON, ${extractedJson.length - jsonLength} символов после)`)
                
                // Проверяем, что мы извлекли правильный JSON - он должен быть массивом
                try {
                  const testParse = JSON.parse(jsonString)
                  if (Array.isArray(testParse) && testParse.length > 0) {
                    console.log(`✅ Извлеченный JSON - массив из ${testParse.length} элементов`)
                    if (testParse[0].transactions) {
                      console.log(`✅ Первый элемент содержит ${testParse[0].transactions.length} транзакций`)
                    }
                  } else if (testParse && typeof testParse === 'object') {
                    console.log(`⚠️ Извлеченный JSON - объект, а не массив. Ключи: ${Object.keys(testParse).join(', ')}`)
                  }
                } catch (e) {
                  console.warn(`⚠️ Не удалось проверить извлеченный JSON: ${e.message}`)
                }
              } else {
                // Если не нашли валидный JSON, пробуем найти закрывающую скобку вручную
                // Ищем последнюю закрывающую скобку/квадратную скобку
                const lastBrace = extractedJson.lastIndexOf('}')
                const lastBracket = extractedJson.lastIndexOf(']')
                const lastClose = Math.max(lastBrace, lastBracket)
                
                if (lastClose > 0) {
                  // Берем все до последней закрывающей скобки + 1
                  const candidateJson = extractedJson.substring(0, lastClose + 1).trim()
                  console.log(`📝 Извлечен JSON по закрывающей скобке (позиция ${lastClose})`)
                  
                  // Проверяем результат
                  try {
                    const testParse = JSON.parse(candidateJson)
                    if (Array.isArray(testParse)) {
                      console.log(`✅ JSON по закрывающей скобке - массив из ${testParse.length} элементов`)
                      jsonString = candidateJson
                      foundValidJson = true
                    } else {
                      console.warn(`⚠️ JSON по закрывающей скобке - не массив, а ${typeof testParse}`)
                      jsonString = candidateJson  // Все равно используем, если это валидный JSON
                    }
                  } catch (e) {
                    console.warn(`⚠️ Не удалось проверить JSON: ${e.message}`)
                    jsonString = candidateJson  // Пробуем использовать, даже если не удалось распарсить
                  }
                } else {
                  // Если не нашли закрывающую скобку, используем весь блок
                  jsonString = extractedJson
                  console.log(`⚠️ Не удалось найти конец JSON, используем весь блок после позиции ${actualStartIndex}`)
                }
              }
            }
            
            // Если jsonString все еще не установлен, используем весь stdout
            if (!jsonString) {
              jsonString = stdoutTrimmed
              console.log(`⚠️ JSON строка не установлена, используем весь stdout`)
            }

            // Парсим JSON
            let result
            try {
              console.log(`🔍 Парсинг JSON строки (длина: ${jsonString.length}, первые 100 символов: ${jsonString.substring(0, 100)})`)
              result = JSON.parse(jsonString)
              console.log(`✅ JSON успешно распарсен. Тип: ${Array.isArray(result) ? 'массив' : typeof result}`)
            } catch (parseError) {
              console.error('❌ Ошибка парсинга JSON:', parseError.message)
              console.error('JSON строка (первые 500 символов):', jsonString.substring(0, 500))
              console.error('JSON строка (последние 200 символов):', jsonString.substring(Math.max(0, jsonString.length - 200)))
              throw parseError
            }
            
            
            // Логируем структуру для отладки
            if (Array.isArray(result) && result.length > 0) {
              console.log(`🔍 Первый результат (массив):`, JSON.stringify({
                has_source_file: !!result[0].source_file,
                source_file: result[0].source_file,
                has_transactions: !!result[0].transactions,
                transactions_count: result[0].transactions ? result[0].transactions.length : 0,
                has_metadata: !!result[0].metadata,
                keys: Object.keys(result[0]),
                first_transaction_keys: result[0].transactions && result[0].transactions.length > 0 ? Object.keys(result[0].transactions[0]) : null
              }, null, 2))
            } else if (result && typeof result === 'object') {
              console.log(`🔍 Результат (не массив):`, JSON.stringify({
                has_source_file: !!result.source_file,
                source_file: result.source_file,
                has_transactions: !!result.transactions,
                transactions_count: result.transactions ? result.transactions.length : 0,
                has_metadata: !!result.metadata,
                keys: Object.keys(result)
              }, null, 2))
              
              // Если это транзакция, а не документ - это проблема
              if (!result.source_file && !result.transactions && ('page_number' in result || 'Дата' in result || 'Кредит' in result)) {
                console.error(`❌ КРИТИЧЕСКАЯ ОШИБКА: Извлеченная JSON строка содержит транзакцию вместо документа!`)
                console.error(`❌ Это означает, что мы извлекли не весь JSON. Нужно найти правильный конец массива.`)
                console.error(`❌ JSON строка (первые 200 символов):`, jsonString.substring(0, 200))
                console.error(`❌ JSON строка (последние 200 символов):`, jsonString.substring(Math.max(0, jsonString.length - 200)))
              }
            }
            
            // Python скрипт всегда возвращает массив документов
            // Каждый документ имеет структуру: {source_file, metadata, transactions}
            // Проверяем, что структура правильная
            if (Array.isArray(result)) {
              // Проверяем каждый элемент массива
              for (let i = 0; i < result.length; i++) {
                if (!result[i] || typeof result[i] !== 'object') {
                  console.warn(`⚠️ Элемент ${i} массива не является объектом:`, typeof result[i])
                } else if (!result[i].source_file && !result[i].transactions) {
                  // Если это не документ, а транзакция - оборачиваем в документ
                  console.warn(`⚠️ Элемент ${i} похож на транзакцию, а не документ. Оборачиваем в документ.`)
                  result[i] = {
                    source_file: filename,
                    metadata: {},
                    transactions: [result[i]]
                  }
                }
              }
            } else if (result && typeof result === 'object') {
              // Если это один объект, проверяем его структуру
              if (!result.source_file && !result.transactions) {
                // Если это транзакция, а не документ - оборачиваем
                console.warn(`⚠️ Результат похож на транзакцию, а не документ. Оборачиваем в документ.`)
                result = {
                  source_file: filename,
                  metadata: {},
                  transactions: [result]
                }
              }
            }
            
            resolve(Array.isArray(result) ? result : [result])
          } catch (parseError) {
            console.error('❌ Ошибка парсинга JSON:', parseError.message)
            console.error('Stdout:', stdout)
            // Если это не JSON, но код успешный - возможно, нет транзакций
            if (code === 0 && stdout.trim().includes('No credit rows found')) {
              resolve([{
                source_file: filename,
                metadata: {},
                transactions: [],
                error: 'Не найдено операций по кредиту в PDF файле'
              }])
            } else {
              reject(new Error(`Не удалось распарсить JSON ответ: ${parseError.message}`))
            }
          }
        })

        pythonProcess.on('error', async (error) => {
          // Удаляем временный файл при ошибке
          try {
            await unlink(tempPdfPath)
          } catch (err) {
            // Игнорируем ошибку удаления
          }
          console.error('❌ Ошибка запуска Python процесса:', error.message)
          reject(new Error(`Не удалось запустить Python скрипт: ${error.message}`))
        })
      }
      
      if (venvExists) {
        // Локальная разработка с venv - запускаем сразу
        actualPythonExecutable = fs.existsSync(venvPython) ? venvPython : venvPythonAlt
        pythonEnv.VIRTUAL_ENV = path.join(resolvedPdfServicePath, 'venv')
        console.log(`✅ Найдено виртуальное окружение: ${actualPythonExecutable}`)
        runPythonConversion()
      } else {
        // Production (Docker или Render.com без venv)
        // В Docker все зависимости установлены глобально, просто запускаем
        console.log(`🐍 Используем системный Python: ${actualPythonExecutable}`)
        runPythonConversion()
      }
    })
  } catch (error) {
    // Удаляем временный файл при ошибке
    try {
      if (fs.existsSync(tempPdfPath)) {
        await unlink(tempPdfPath)
      }
    } catch (err) {
      // Игнорируем ошибку удаления
    }
    throw error
  }
}

/**
 * Конвертирует массив PDF файлов в JSON
 * @param {Array<{buffer: Buffer, filename: string}>} files - Массив файлов
 * @returns {Promise<Array>} Массив результатов конвертации
 */
async function convertPdfsToJson(files) {
  const results = []
  
  for (const file of files) {
    try {
      const result = await convertPdfToJson(file.buffer, file.filename)
      
      // Python скрипт возвращает массив документов, каждый документ имеет структуру:
      // {source_file: string, metadata: object, transactions: array}
      // Мы просто добавляем все документы в results
      if (Array.isArray(result)) {
        // Если это массив документов, добавляем каждый документ
        for (const doc of result) {
          if (doc && typeof doc === 'object') {
            results.push(doc)
          }
        }
      } else if (result && typeof result === 'object') {
        // Если это один документ, добавляем его
        results.push(result)
      } else {
        console.warn(`⚠️ Неожиданный тип результата: ${typeof result}`, result)
      }
    } catch (error) {
      console.error(`❌ Ошибка конвертации файла ${file.filename}:`, error.message)
      // Добавляем ошибку в результат, чтобы пользователь видел, что произошло
      results.push({
        source_file: file.filename,
        metadata: {},
        transactions: [],
        error: error.message
      })
    }
  }
  
  return results
}

module.exports = {
  convertPdfToJson,
  convertPdfsToJson
}

