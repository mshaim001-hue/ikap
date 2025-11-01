# Деплой фронтенда на GitHub Pages

## Шаг 1: Настройка переменных окружения для сборки

Вам нужно установить переменные окружения в GitHub Actions или локально перед деплоем:

### Вариант 1: Через GitHub Actions (рекомендуется)

1. Откройте настройки репозитория на GitHub
2. Перейдите в Settings → Secrets and variables → Actions
3. Добавьте следующие секреты:
   - `VITE_API_BASE_URL` - URL вашего API на Render.com (например: `https://ikap-1.onrender.com`)
   - `VITE_BASE_PATH` - базовый путь для GitHub Pages (например: `/ikap/` или `/`)

### Вариант 2: Локально перед деплоем

Создайте файл `.env.production` в корне проекта:
```
VITE_API_BASE_URL=https://ikap-1.onrender.com
VITE_BASE_PATH=/ikap/
```

## Шаг 2: Деплой на GitHub Pages

### Автоматический деплой через GitHub Actions

1. Создайте файл `.github/workflows/deploy.yml`:
```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        env:
          VITE_API_BASE_URL: ${{ secrets.VITE_API_BASE_URL }}
          VITE_BASE_PATH: ${{ secrets.VITE_BASE_PATH || '/ikap/' }}
        run: npm run build
      
      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
```

### Ручной деплой

```bash
# Установите переменные окружения
export VITE_API_BASE_URL=https://ikap-1.onrender.com
export VITE_BASE_PATH=/ikap/

# Соберите проект
npm run build

# Задеплойте
npm run deploy
```

## Шаг 3: Включение GitHub Pages

1. Откройте настройки репозитория на GitHub
2. Перейдите в Settings → Pages
3. В разделе "Source" выберите:
   - Branch: `gh-pages`
   - Folder: `/ (root)`
4. Сохраните изменения

## Шаг 4: Настройка CORS на Render.com

Убедитесь что на Render.com добавлена переменная окружения:
- `FRONTEND_URL` = URL вашего GitHub Pages сайта (например: `https://username.github.io`)

Или разрешите все GitHub Pages домены в CORS (уже настроено в коде).

## Проверка

После деплоя:
1. Откройте ваш GitHub Pages сайт
2. Откройте консоль браузера (F12)
3. Проверьте что API запросы идут на правильный URL (Render.com)

## Troubleshooting

### Проблема: API запросы идут на GitHub Pages вместо Render.com

**Решение:** Проверьте что `VITE_API_BASE_URL` правильно настроен в секретах GitHub Actions

### Проблема: CORS ошибки

**Решение:** 
1. Проверьте что `FRONTEND_URL` добавлен на Render.com
2. Или убедитесь что ваш GitHub Pages домен разрешен в CORS

### Проблема: 404 на GitHub Pages

**Решение:** Проверьте `VITE_BASE_PATH` - он должен соответствовать имени вашего репозитория

