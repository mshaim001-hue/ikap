# Решение проблем с Docker

## Проблема: docker-credential-desktop not found

### Решение 1: Изменить credsStore (уже исправлено)

Конфигурация Docker была обновлена. Если проблема повторится:

```bash
# Проверьте текущую конфигурацию
cat ~/.docker/config.json

# Если там "credsStore": "desktop", измените на:
cat > ~/.docker/config.json << 'EOF'
{
  "auths": {
    "https://index.docker.io/v1/": {}
  },
  "credsStore": "osxkeychain"
}
EOF
```

### Решение 2: Удалить credsStore (если не нужны credentials)

```bash
cat > ~/.docker/config.json << 'EOF'
{
  "auths": {
    "https://index.docker.io/v1/": {}
  }
}
EOF
```

## Проблема: Cannot connect to Docker daemon

### Решение:

1. **Убедитесь что Docker Desktop запущен:**
   - Откройте Docker Desktop приложение
   - Дождитесь полной загрузки (иконка в меню должна быть зеленая)

2. **Проверьте статус:**
```bash
docker info
```

3. **Если не помогает, перезапустите Docker Desktop:**
   - Закройте Docker Desktop
   - Откройте снова
   - Подождите пока запустится

4. **Проверьте контекст:**
```bash
docker context ls
docker context use default
```

## Сборка образа

После исправления проблем, соберите образ:

```bash
# Для локальной платформы
docker build -t mshaim001/ikap1-backend:latest .

# Для linux/amd64 (для деплоя на сервер)
docker build --platform linux/amd64 -t mshaim001/ikap1-backend:latest .
```

## Публикация в Docker Hub

```bash
# Вход в Docker Hub
docker login

# Публикация
docker push mshaim001/ikap1-backend:latest
```

