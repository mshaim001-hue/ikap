# Docker Image URL для деплоя

## URL образа

После публикации в Docker Hub, ваш образ будет доступен по следующему URL:

```
docker.io/mshaim001/ikap1-backend:latest
```

Или короткая форма (Docker автоматически добавит `docker.io/`):

```
mshaim001/ikap1-backend:latest
```

## Публикация образа

Если еще не опубликовали, выполните:

```bash
# Вход в Docker Hub
docker login

# Публикация
docker push mshaim001/ikap1-backend:latest
```

## Использование для деплоя

### На Render.com

В настройках сервиса укажите:
- **Image URL**: `mshaim001/ikap1-backend:latest`
- **Platform**: Docker
- **Port**: `8787`

### На других платформах

#### Railway
```yaml
# railway.json или в настройках
{
  "docker": {
    "image": "mshaim001/ikap1-backend:latest"
  }
}
```

#### DigitalOcean App Platform
- **Source Type**: Docker Hub
- **Image**: `mshaim001/ikap1-backend:latest`
- **Tag**: `latest`

#### AWS ECS / Fargate
```json
{
  "image": "mshaim001/ikap1-backend:latest",
  "portMappings": [
    {
      "containerPort": 8787,
      "hostPort": 8787
    },
    {
      "containerPort": 5000,
      "hostPort": 5000
    }
  ]
}
```

#### Google Cloud Run
```bash
gcloud run deploy ikap \
  --image docker.io/mshaim001/ikap1-backend:latest \
  --platform managed \
  --port 8787 \
  --allow-unauthenticated
```

#### Azure Container Instances
```bash
az container create \
  --resource-group myResourceGroup \
  --name ikap \
  --image mshaim001/ikap1-backend:latest \
  --ports 8787 5000
```

## Переменные окружения

Не забудьте установить переменные окружения на платформе деплоя:

```env
OPENAI_API_KEY=your_openai_api_key
DATABASE_URL=your_postgresql_connection_string
PORT=8787
NODE_ENV=production
FRONTEND_URL=https://your-domain.com
```

## Проверка образа

Проверить что образ доступен:

```bash
# Проверка на Docker Hub
curl -s https://hub.docker.com/v2/repositories/mshaim001/ikap1-backend/tags/ | grep -o '"name":"[^"]*"'

# Или через Docker
docker pull mshaim001/ikap1-backend:latest
```

## Обновление образа

После изменений в коде:

1. Пересоберите образ:
```bash
docker build --platform linux/amd64 -t mshaim001/ikap1-backend:latest .
```

2. Опубликуйте новую версию:
```bash
docker push mshaim001/ikap1-backend:latest
```

3. Платформа автоматически подхватит обновление (или перезапустите сервис вручную)

## Тегирование версий

Рекомендуется использовать версионирование:

```bash
# Сборка с версией
docker build --platform linux/amd64 -t mshaim001/ikap1-backend:1.0.0 .
docker build --platform linux/amd64 -t mshaim001/ikap1-backend:latest .

# Публикация
docker push mshaim001/ikap1-backend:1.0.0
docker push mshaim001/ikap1-backend:latest
```

Тогда можно использовать конкретную версию:
```
mshaim001/ikap1-backend:1.0.0
```

