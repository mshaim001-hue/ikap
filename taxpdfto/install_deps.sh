#!/bin/bash
# Скрипт для установки Python зависимостей для taxpdfto

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "🔍 Проверка наличия Python..."
if command -v python3 &> /dev/null; then
    PYTHON=python3
    echo "✅ Найден python3: $(which python3)"
elif command -v python &> /dev/null; then
    PYTHON=python
    echo "✅ Найден python: $(which python)"
else
    echo "⚠️ Python не найден в системе, пропускаем установку зависимостей"
    exit 0
fi

echo "📦 Установка зависимостей из requirements.txt..."
if [ -f "requirements.txt" ]; then
    # Пробуем разные способы установки
    if $PYTHON -m pip install --user -r requirements.txt 2>&1; then
        echo "✅ Зависимости установлены (python3 -m pip --user)"
    elif $PYTHON -m pip install -r requirements.txt 2>&1; then
        echo "✅ Зависимости установлены (python3 -m pip)"
    elif pip3 install --user -r requirements.txt 2>&1; then
        echo "✅ Зависимости установлены (pip3 --user)"
    elif pip3 install -r requirements.txt 2>&1; then
        echo "✅ Зависимости установлены (pip3)"
    elif pip install --user -r requirements.txt 2>&1; then
        echo "✅ Зависимости установлены (pip --user)"
    elif pip install -r requirements.txt 2>&1; then
        echo "✅ Зависимости установлены (pip)"
    else
        echo "⚠️ Не удалось установить зависимости автоматически, продолжаем без них"
        exit 0
    fi
else
    echo "⚠️ Файл requirements.txt не найден, пропускаем установку"
    exit 0
fi

