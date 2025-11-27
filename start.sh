#!/bin/bash
set -e

echo "🚀 Starting iKapitalist application..."

# Запускаем Python Flask сервер в фоне
echo "📄 Starting Python Flask server (PDF parser)..."
cd /app/taxpdfto
python3 app.py &
PYTHON_PID=$!
echo "✅ Python Flask server started with PID $PYTHON_PID"

# Ждем немного, чтобы Python сервер успел запуститься
sleep 2

# Запускаем Node.js сервер в фоне
echo "🟢 Starting Node.js server..."
cd /app
node server/index.js &
NODE_PID=$!
echo "✅ Node.js server started with PID $NODE_PID"

# Функция для корректного завершения
cleanup() {
    echo "🛑 Shutting down services..."
    kill $NODE_PID $PYTHON_PID 2>/dev/null || true
    wait $NODE_PID $PYTHON_PID 2>/dev/null || true
    echo "✅ Services stopped"
    exit 0
}

# Обрабатываем сигналы завершения (используем bash синтаксис)
trap cleanup SIGTERM SIGINT EXIT

# Ждем завершения процессов
wait $NODE_PID $PYTHON_PID

