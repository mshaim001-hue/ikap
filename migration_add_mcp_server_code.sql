-- Миграция для добавления поля mcp_server_code в таблицу agent_settings
-- Выполните этот SQL в Supabase SQL Editor

-- Добавляем колонку для хранения кода MCP сервера
ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS mcp_server_code TEXT;

-- Копируем код из файла в БД для существующей записи Information Agent (если нужно)
-- Это можно сделать вручную через интерфейс настроек

-- Проверка: посмотреть структуру таблицы
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'agent_settings';

