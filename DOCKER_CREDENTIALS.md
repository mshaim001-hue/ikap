# Docker Hub Credentials для деплоя

## Нужны ли Credentials?

### ✅ НЕ нужны, если:
- **Репозиторий публичный (Public)** - это стандартная настройка по умолчанию
- Любой может скачать образ без авторизации
- Для большинства случаев это оптимальный вариант

### ❌ Нужны, если:
- **Репозиторий приватный (Private)**
- Вы хотите ограничить доступ к образу
- Используете приватные зависимости

## Как проверить статус репозитория

1. Зайдите на https://hub.docker.com
2. Найдите репозиторий `mshaim001/ikap1-backend`
3. Проверьте настройки - должен быть переключатель "Public/Private"

## Как сделать репозиторий публичным

1. Зайдите на Docker Hub → ваш репозиторий
2. Settings → Public/Private
3. Выберите **Public**
4. Сохраните

## Если нужны Credentials (для приватного репозитория)

### На Render.com:
```
Username: ваш_dockerhub_username
Password: ваш_dockerhub_password
```

Или используйте **Access Token** (рекомендуется):
1. Docker Hub → Account Settings → Security
2. Create Access Token
3. Используйте токен как пароль

### На других платформах:

**Railway:**
```json
{
  "docker": {
    "image": "mshaim001/ikap1-backend:latest",
    "auth": {
      "username": "your_username",
      "password": "your_token"
    }
  }
}
```

**DigitalOcean:**
- Registry: Docker Hub
- Username: ваш_username
- Password: ваш_token

## Рекомендация

**Для большинства случаев:**
- ✅ Сделайте репозиторий **публичным**
- ✅ Credentials **НЕ нужны**
- ✅ Проще деплой и обновления

**Для приватных проектов:**
- Используйте **Access Token** вместо пароля
- Более безопасно
- Можно отозвать токен без смены пароля

## Создание Access Token (если нужен приватный репозиторий)

1. Docker Hub → Account Settings → Security
2. New Access Token
3. Название: `deploy-token`
4. Permissions: `Read` (достаточно для pull)
5. Скопируйте токен (показывается только один раз!)

Используйте токен как пароль в настройках деплоя.

