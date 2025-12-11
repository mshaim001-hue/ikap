#!/bin/bash
set -e

echo "🚀 Starting iKapitalist application..."

echo "🟢 Starting Node.js server..."
cd /app
node server/index.js &
NODE_PID=$!
echo "✅ Node.js server started with PID $NODE_PID"

# Функция для корректного завершения
cleanup() {
    echo "🛑 Shutting down services..."
    kill $NODE_PID 2>/dev/null || true
    wait $NODE_PID 2>/dev/null || true
    echo "✅ Services stopped"
    exit 0
}

# Обрабатываем сигналы завершения (используем bash синтаксис)
trap cleanup SIGTERM SIGINT EXIT

# Ждем завершения процесса Node.js
wait $NODE_PID

