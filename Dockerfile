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

# Устанавливаем системные зависимости для Python и PDF обработки
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Копируем и устанавливаем Python зависимости
# Используем тот же подход, что и в рабочем проекте
COPY taxpdfto/requirements.txt ./taxpdfto/
COPY pdf/requirements.txt ./pdf/
RUN cd taxpdfto && \
    python3 -m pip install --upgrade pip setuptools wheel && \
    python3 -m pip install -r requirements.txt && \
    cd .. && \
    cd pdf && \
    python3 -m pip install --upgrade pip setuptools wheel && \
    python3 -m pip install -r requirements.txt && \
    python3 -c "import adobe.pdfservices.operation; print('✅ pdfservices-sdk установлен и импортируется успешно')" && \
    cd ..

# Копируем package файлы
COPY package*.json ./

# Устанавливаем только production зависимости Node.js
RUN npm ci --only=production

# Копируем собранный фронтенд
COPY --from=frontend-builder /app/dist ./dist

# Копируем серверный код
COPY server/ ./server/

# Копируем Python приложения
COPY taxpdfto/ ./taxpdfto/
COPY pdf/ ./pdf/

# Создаем директории для загрузок
RUN mkdir -p /app/taxpdfto/uploads && \
    mkdir -p /app/pdf/uploads

# Копируем скрипт запуска
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Открываем порты
# 8787 - Node.js сервер
# 5000 - Python Flask сервер
EXPOSE 8787 5000

# Переменные окружения
ENV NODE_ENV=production
# PORT будет установлен платформой деплоя (Render, Railway и т.д.)
# ENV PORT=8787  # Раскомментируйте только для локального запуска
ENV PYTHON_PORT=5000
ENV FLASK_DEBUG=False

# Запускаем оба сервиса
CMD ["/bin/bash", "/app/start.sh"]

