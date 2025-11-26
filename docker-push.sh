#!/bin/bash

# Скрипт для сборки и публикации образа в Docker Hub
# Использование: ./docker-push.sh [your-dockerhub-username] [version]

set -e

DOCKER_USERNAME=${1:-"yourusername"}
VERSION=${2:-"latest"}

if [ "$DOCKER_USERNAME" == "yourusername" ]; then
    echo "❌ Ошибка: Укажите ваш Docker Hub username"
    echo "Использование: ./docker-push.sh yourusername [version]"
    exit 1
fi

IMAGE_NAME="ikap"
FULL_IMAGE_NAME="${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}"

echo "🔨 Сборка образа ${FULL_IMAGE_NAME}..."
docker build -t ${IMAGE_NAME}:${VERSION} .

echo "🏷️  Тегирование образа..."
docker tag ${IMAGE_NAME}:${VERSION} ${FULL_IMAGE_NAME}

if [ "$VERSION" != "latest" ]; then
    docker tag ${IMAGE_NAME}:${VERSION} ${DOCKER_USERNAME}/${IMAGE_NAME}:latest
    echo "✅ Также создан тег latest"
fi

echo "📤 Публикация в Docker Hub..."
echo "⚠️  Убедитесь что вы залогинены: docker login"
read -p "Продолжить публикацию? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker push ${FULL_IMAGE_NAME}
    if [ "$VERSION" != "latest" ]; then
        docker push ${DOCKER_USERNAME}/${IMAGE_NAME}:latest
    fi
    echo "✅ Образ успешно опубликован!"
    echo "📦 Имя образа: ${FULL_IMAGE_NAME}"
else
    echo "❌ Публикация отменена"
fi

