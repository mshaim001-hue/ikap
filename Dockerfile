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
FROM node:20-alpine

WORKDIR /app

# Устанавливаем Python и системные зависимости для pdfplumber
# pdfplumber требует дополнительные библиотеки для работы с PDF
RUN apk add --no-cache \
    python3 \
    py3-pip \
    gcc \
    g++ \
    musl-dev \
    python3-dev \
    jpeg-dev \
    zlib-dev \
    freetype-dev \
    lcms2-dev \
    openjpeg-dev \
    tiff-dev \
    tk-dev \
    tcl-dev \
    harfbuzz-dev \
    fribidi-dev \
    libimagequant-dev \
    libxcb-dev \
    libpng-dev \
    && ln -sf python3 /usr/bin/python \
    && ln -sf pip3 /usr/bin/pip

# Копируем и устанавливаем Python зависимости
# Используем --break-system-packages так как это изолированный Docker контейнер
COPY taxpdfto/requirements.txt ./taxpdfto/
RUN pip install --no-cache-dir --upgrade pip --break-system-packages && \
    pip install --no-cache-dir --break-system-packages -r taxpdfto/requirements.txt

# Копируем package файлы
COPY package*.json ./

# Устанавливаем только production зависимости Node.js
RUN npm ci --only=production

# Копируем собранный фронтенд
COPY --from=frontend-builder /app/dist ./dist

# Копируем серверный код
COPY server/ ./server/

# Копируем Python приложение
COPY taxpdfto/ ./taxpdfto/

# Создаем директорию для загрузок
RUN mkdir -p /app/taxpdfto/uploads

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
CMD ["/app/start.sh"]

