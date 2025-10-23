# iKapitalist Frontend
kjfhsal
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
