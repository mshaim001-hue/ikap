# Multi-stage build для оптимизации размера образа

# Этап 1: Сборка фронтенда
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Копируем package файлы
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci

# Копируем исходники фронтенда
COPY vite.config.js ./
COPY index.html ./
COPY src/ ./src/
COPY public/ ./public/

# Собираем фронтенд
RUN npm run build

# Этап 2: Финальный образ
FROM node:20-bullseye

WORKDIR /app

# Копируем package файлы
COPY package*.json ./

# Устанавливаем только production зависимости Node.js
RUN npm ci --only=production

# Копируем собранный фронтенд
COPY --from=frontend-builder /app/dist ./dist

# Копируем серверный код
COPY server/ ./server/

# Копируем скрипт запуска
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Открываем порт Node.js сервера
EXPOSE 8787

# Переменные окружения
ENV NODE_ENV=production
# PORT будет установлен платформой деплоя (Render, Railway и т.д.)
# ENV PORT=8787  # Раскомментируйте только для локального запуска

# Запускаем только Node.js сервер
CMD ["/bin/bash", "/app/start.sh"]


