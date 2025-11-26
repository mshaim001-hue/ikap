# Настройка PDF сервиса для парсинга банковских выписок

## Что было сделано

✅ Скопирована вся логика парсинга банковских выписок из проекта `/Users/mshaimard/Desktop/ikap2`:
- Папка `pdf/` со всеми Python модулями
- `pdf/app/cli.py` - CLI для парсинга
- `pdf/app/pdf_processor.py` - основной процессор
- `pdf/app/adobe_pdf_service.py` - интеграция с Adobe API
- `pdf/requirements.txt` - зависимости Python

✅ Обновлен `Dockerfile`:
- Добавлена установка зависимостей PDF сервиса
- Добавлено копирование папки `pdf/` в Docker образ

✅ Обновлен `server/pdfConverter.js`:
- Исправлены пути к PDF сервису для Docker (`/app/pdf/app/cli.py`)
- Добавлены альтернативные пути для разных окружений

✅ Инструкции для агентов уже настроены:
- `Investment Agent` - собирает данные и принимает выписки
- `Financial Analyst Agent` - анализирует выписки и создает отчеты

## Требования

### Adobe PDF Services API

PDF сервис **обязательно требует** Adobe PDF Services API credentials:

1. **Client ID и Client Secret** (через переменные окружения):
   ```bash
   ADOBE_CLIENT_ID=your_client_id
   ADOBE_CLIENT_SECRET=your_client_secret
   ADOBE_REGION=US  # или EU
   ```

2. **Или credentials файл**:
   ```bash
   ADOBE_CREDENTIALS_FILE=/path/to/pdfservices-api-credentials.json
   ```

### Установка зависимостей

Зависимости PDF сервиса автоматически устанавливаются при сборке Docker образа:
- `pdfservices-sdk` - Adobe PDF Services SDK
- `pandas` - обработка данных
- `openpyxl` - работа с Excel
- `fastapi`, `uvicorn` - для HTTP сервиса (опционально)

## Использование

### Автоматический режим (рекомендуется)

PDF сервис автоматически используется при загрузке банковских выписок через API `/api/agents/run`:
1. Пользователь загружает PDF выписки
2. Система автоматически вызывает `pdf/app/cli.py` для парсинга
3. Результат конвертируется в JSON с транзакциями
4. Транзакции анализируются агентом `Financial Analyst`

### Ручной вызов (для тестирования)

```bash
# В Docker контейнере
python3 -m pdf.app.cli /path/to/statement.pdf --json

# Локально
cd pdf
python3 -m app.cli ../test_statement.pdf --json
```

## Структура проекта

```
ikap/
├── pdf/                    # PDF сервис для парсинга выписок
│   ├── app/
│   │   ├── __init__.py
│   │   ├── cli.py          # CLI интерфейс
│   │   ├── pdf_processor.py    # Основной процессор
│   │   ├── adobe_pdf_service.py # Adobe API интеграция
│   │   └── main.py         # FastAPI сервер (опционально)
│   ├── requirements.txt    # Python зависимости
│   └── README.md
├── server/
│   └── pdfConverter.js     # Node.js обертка для PDF сервиса
└── Dockerfile              # Обновлен для включения PDF сервиса
```

## Процесс работы

1. **PDF → Excel**: Adobe API конвертирует PDF в Excel (XLSX)
2. **Excel → DataFrame**: pandas читает Excel файл
3. **Фильтрация**: извлекаются только строки с заполненным столбцом "Кредит"
4. **Очистка**: удаляются итоговые строки, дубликаты, пустые значения
5. **JSON**: результат возвращается в формате JSON

## Важные замечания

⚠️ **Adobe API обязателен** - без credentials парсинг не будет работать

⚠️ **Платный сервис** - Adobe PDF Services API требует подписки (есть пробный период)

⚠️ **Переменные окружения** - убедитесь, что `ADOBE_CLIENT_ID` и `ADOBE_CLIENT_SECRET` установлены в Render.com

## Следующие шаги

1. **Установите Adobe credentials в Render.com**:
   - Settings → Environment Variables
   - Добавьте `ADOBE_CLIENT_ID` и `ADOBE_CLIENT_SECRET`

2. **Пересоберите Docker образ**:
   ```bash
   ./docker-push.sh your-dockerhub-username latest
   ```

3. **Перезапустите сервис на Render.com**

4. **Проверьте работу**:
   - Загрузите тестовую банковскую выписку через фронтенд
   - Проверьте логи - должны появиться сообщения о парсинге

## Логирование

При работе PDF сервиса в логах будут видны:
- `[CLI]` - логи CLI интерфейса
- `[PDF_PROCESSOR]` - логи процессора
- `[ADOBE_SERVICE]` - логи Adobe API

Все логи выводятся в `stderr`, чтобы не мешать JSON в `stdout`.

