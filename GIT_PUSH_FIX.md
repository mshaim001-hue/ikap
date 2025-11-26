# Решение проблемы с git push (403 Permission denied)

## Проблема
```
remote: Permission to mshaim001-hue/ikap.git denied to maximkz2025-2.
fatal: unable to access 'https://github.com/mshaim001-hue/ikap.git/': The requested URL returned error: 403
```

## Решение 1: Использовать Personal Access Token (Рекомендуется)

### Шаг 1: Создайте Personal Access Token на GitHub

1. Зайдите на https://github.com/settings/tokens
2. Нажмите **Generate new token** → **Generate new token (classic)**
3. Название: `ikap-deploy`
4. Срок действия: выберите нужный (или `No expiration`)
5. Права (scopes):
   - ✅ `repo` (полный доступ к репозиториям)
   - ✅ `workflow` (для GitHub Actions)
6. Нажмите **Generate token**
7. **ВАЖНО**: Скопируйте токен сразу (показывается только один раз!)

### Шаг 2: Используйте токен для push

```bash
# При следующем push Git спросит пароль - введите токен вместо пароля
git push

# Или укажите токен в URL (временно)
git push https://YOUR_TOKEN@github.com/mshaim001-hue/ikap.git
```

### Шаг 3: Сохраните токен в keychain (macOS)

```bash
# Git автоматически сохранит токен в keychain при первом использовании
# Или вручную:
git credential-osxkeychain store
# Затем введите:
# protocol=https
# host=github.com
# username=mshaim001-hue
# password=YOUR_TOKEN
```

## Решение 2: Переключиться на SSH

### Шаг 1: Проверьте наличие SSH ключа

```bash
ls -la ~/.ssh/id_*.pub
```

Если нет, создайте:
```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

### Шаг 2: Добавьте SSH ключ на GitHub

```bash
# Скопируйте публичный ключ
cat ~/.ssh/id_ed25519.pub
# Или
pbcopy < ~/.ssh/id_ed25519.pub
```

1. GitHub → Settings → SSH and GPG keys
2. New SSH key
3. Вставьте ключ и сохраните

### Шаг 3: Измените remote URL на SSH

```bash
git remote set-url origin git@github.com:mshaim001-hue/ikap.git
git push
```

## Решение 3: Обновить credentials в keychain

```bash
# Удалите старые credentials
git credential-osxkeychain erase
# Затем введите:
# protocol=https
# host=github.com
# (нажмите Enter дважды)

# При следующем push Git спросит новые credentials
git push
```

## Быстрое решение (временное)

Если нужно срочно запушить:

```bash
# Используйте токен напрямую в URL
git remote set-url origin https://YOUR_TOKEN@github.com/mshaim001-hue/ikap.git
git push
```

**⚠️ Внимание**: Не коммитьте токен в код! Это только для временного использования.

## Проверка

После настройки проверьте:

```bash
git remote -v
git push --dry-run
```

## Рекомендация

Для долгосрочного использования лучше:
1. ✅ Создать Personal Access Token
2. ✅ Использовать SSH (более безопасно)
3. ✅ Настроить правильные credentials в keychain

