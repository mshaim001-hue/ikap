# iKapitalist Frontend
kjfhsal sdfsd ыва
Инвестиционная платформа iKapitalist с AI-чатботом на базе OpenAI ChatKit и Agent Builder для привлечения инвестиций.

## Установка и запуск

1. Установите зависимости:
```bash
npm install
```

2. Настройте OpenAI ChatKit и Agent Builder:
```bash
# Скопируйте файл с примером переменных окружения
cp env.example .env

# Отредактируйте .env файл:
# 1. Добавьте ваш OpenAI API ключ
# 2. Создайте Agent Builder workflow для регистрации инвестиций
# 3. Добавьте Workflow ID в .env файл
```

3. Запустите проект в режиме разработки:
```bash
npm run dev
```

4. Откройте браузер по адресу http://localhost:3000

## Структура проекта

- `src/components/` - React компоненты
- `src/components/Layout.jsx` - Основной layout
- `src/components/Header.jsx` - Шапка сайта
- `src/components/Sidebar.jsx` - Левая боковая панель
- `src/components/MainContent.jsx` - Основной контент с чат-ботом
- `src/components/ChatKitWidget.jsx` - ChatKit виджет для регистрации
- `src/components/RightSidebar.jsx` - Правая боковая панель
- `src/services/chatkitService.js` - Сервис для работы с ChatKit API

## Технологии

- React 18
- Vite
- OpenAI ChatKit
- OpenAI Agent Builder
- Lucide React (иконки)
- CSS3

## Функциональность

- 🤖 **AI Чат-бот** на базе OpenAI ChatKit
- 🛠️ **Agent Builder** для создания workflow
- 💬 Интерактивный диалог с пользователем
- 📋 Пошаговая регистрация через чат
- 🎨 Современный UI/UX дизайн
- 📱 Адаптивная верстка
- 🔄 Полная интеграция с OpenAI ChatKit

## Настройка OpenAI ChatKit

1. **Получите API ключ** на [platform.openai.com](https://platform.openai.com/api-keys)
2. **Создайте Agent Builder workflow:**
   - Перейдите на [platform.openai.com/agent-builder](https://platform.openai.com/agent-builder)
   - Создайте новый workflow для регистрации инвестиций
   - Настройте шаги: сбор информации о компании, суммы, сроков, целей
   - Скопируйте Workflow ID
3. **Создайте файл `.env`** в корне проекта
4. **Добавьте переменные:**
   ```
   VITE_OPENAI_API_KEY=your_api_key_here
   VITE_CHATKIT_WORKFLOW_ID=your_workflow_id_here
   ```
5. **Перезапустите сервер разработки**

**Примечание:** Для работы чат-бота необходимо настроить OpenAI API ключ и создать Agent Builder workflow.

## Деплой на GitHub Pages

Проект настроен для автоматического деплоя на GitHub Pages.

### Автоматический деплой

1. **Настройте GitHub Pages в репозитории:**
   - Перейдите в Settings → Pages
   - Выберите Source: "GitHub Actions"

2. **Загрузите код в GitHub:**
   ```bash
   git add .
   git commit -m "Setup GitHub Pages deployment"
   git push origin main
   ```

3. **Деплой произойдет автоматически** при каждом push в ветку `main`

### Ручной деплой

Если нужно задеплоить вручную:

```bash
# Установите зависимости
npm install

# Соберите проект
npm run build

# Задеплойте на GitHub Pages
npm run deploy
```

### URL проекта

После деплоя проект будет доступен по адресу:
`https://yourusername.github.io/ikap/`

**Важно:** Убедитесь, что в `vite.config.js` правильно настроен `base` путь для вашего репозитория.

## Настройка переменных окружения для production

Для работы приложения в production необходимо настроить GitHub Secrets:

### 1. Добавьте секреты в GitHub:

1. **Перейди в:** `https://github.com/mshaim001-hue/ikap/settings/secrets/actions`
2. **Нажми "New repository secret"**
3. **Добавь следующие секреты:**

#### VITE_OPENAI_API_KEY
- **Name:** `VITE_OPENAI_API_KEY`
- **Value:** твой OpenAI API ключ (получи на https://platform.openai.com/api-keys)

#### VITE_API_BASE_URL  
- **Name:** `VITE_API_BASE_URL`
- **Value:** URL твоего задеплоенного бэкенда (например: `https://your-backend.railway.app`)

### 2. Деплой бэкенда

Для работы приложения необходимо задеплоить бэкенд сервер (`server/index.js`):

#### Варианты деплоя бэкенда:
- **Railway:** https://railway.app (рекомендуется)
- **Render:** https://render.com
- **Heroku:** https://heroku.com
- **Vercel:** https://vercel.com

#### Инструкция для Railway:
1. Зарегистрируйся на Railway
2. Создай новый проект
3. Подключи GitHub репозиторий
4. Railway автоматически определит Node.js приложение
5. Добавь переменные окружения в Railway:
   - `OPENAI_API_KEY` - твой OpenAI API ключ
   - `DATABASE_URL` - для SQLite (опционально)
6. Скопируй URL приложения и добавь в GitHub Secrets как `VITE_API_BASE_URL`

### 3. После настройки секретов:

1. **Загрузи изменения:**
   ```bash
   git add .
   git commit -m "Add environment variables for production"
   git push origin main
   ```

2. **GitHub Actions автоматически пересоберет** приложение с переменными окружения

3. **Проверь деплой** в разделе Actions
