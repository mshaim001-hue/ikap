# Деплой через Docker Hub

Это руководство по деплою приложения iKapitalist через Docker Hub.

## Структура

Проект использует multi-stage Docker build для оптимизации размера образа:
- **Этап 1**: Сборка React фронтенда
- **Этап 2**: Установка Python зависимостей
- **Этап 3**: Финальный образ с Node.js и Python

## Локальная сборка и тестирование

### 1. Сборка образа

```bash
docker build -t ikap:latest .
```

### 2. Запуск через docker-compose

```bash
docker-compose up -d
```

Или напрямую через Docker:

```bash
docker run -d \
  -p 8787:8787 \
  -p 5000:5000 \
  --name ikap-app \
  -e OPENAI_API_KEY=your_key_here \
  ikap:latest
```

### 3. Проверка работы

- Node.js сервер: http://localhost:8787
- Python Flask сервер: http://localhost:5000

## Публикация в Docker Hub

### 1. Вход в Docker Hub

```bash
docker login
```

### 2. Тегирование образа

Замените `yourusername` на ваш Docker Hub username:

```bash
docker tag ikap:latest yourusername/ikap:latest
docker tag ikap:latest yourusername/ikap:1.0.0
```

### 3. Публикация

```bash
docker push yourusername/ikap:latest
docker push yourusername/ikap:1.0.0
```

## Деплой на сервер

### 1. Подключение к серверу и установка Docker

```bash
# На сервере
sudo apt-get update
sudo apt-get install -y docker.io docker-compose
sudo systemctl start docker
sudo systemctl enable docker
```

### 2. Загрузка и запуск образа

```bash
# Вход в Docker Hub
docker login

# Загрузка образа
docker pull yourusername/ikap:latest

# Запуск контейнера
docker run -d \
  -p 8787:8787 \
  -p 5000:5000 \
  --name ikap-app \
  --restart unless-stopped \
  -e OPENAI_API_KEY=your_key_here \
  -e DATABASE_URL=your_database_url \
  -v $(pwd)/.env:/app/.env:ro \
  yourusername/ikap:latest
```

Или используйте docker-compose на сервере:

```bash
# Скачайте docker-compose.yml на сервер
# Отредактируйте переменные окружения
docker-compose pull
docker-compose up -d
```

## Переменные окружения

Создайте файл `.env` или передайте переменные через `-e`:

```env
OPENAI_API_KEY=your_openai_api_key
DATABASE_URL=your_database_url
PORT=8787
NODE_ENV=production
FRONTEND_URL=https://your-domain.com
```

## Обновление приложения

### На сервере:

```bash
# Остановить контейнер
docker stop ikap-app
docker rm ikap-app

# Загрузить новую версию
docker pull yourusername/ikap:latest

# Запустить заново
docker run -d \
  -p 8787:8787 \
  -p 5000:5000 \
  --name ikap-app \
  --restart unless-stopped \
  -e OPENAI_API_KEY=your_key_here \
  yourusername/ikap:latest
```

Или через docker-compose:

```bash
docker-compose pull
docker-compose up -d
```

## Мониторинг

### Просмотр логов

```bash
docker logs -f ikap-app
```

### Проверка статуса

```bash
docker ps
docker stats ikap-app
```

## Troubleshooting

### Проблемы с Python зависимостями

Если возникают проблемы с pdfplumber, убедитесь что в образе установлены все системные зависимости. Они уже включены в Dockerfile.

### Проблемы с портами

Убедитесь что порты 8787 и 5000 не заняты другими приложениями:

```bash
sudo netstat -tulpn | grep -E '8787|5000'
```

### Проблемы с правами доступа

Если возникают проблемы с записью файлов, проверьте права на директорию uploads:

```bash
docker exec ikap-app ls -la /app/taxpdfto/uploads
```

