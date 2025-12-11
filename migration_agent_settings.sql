-- Миграция для создания таблицы agent_settings
-- Выполните этот SQL в Supabase SQL Editor

-- Таблица для хранения настроек агентов
CREATE TABLE IF NOT EXISTS agent_settings (
  id SERIAL PRIMARY KEY,
  agent_name TEXT UNIQUE NOT NULL,
  instructions TEXT NOT NULL,
  mcp_config JSONB,
  model TEXT DEFAULT 'gpt-5-mini',
  model_settings JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Создаем индекс для быстрого поиска по agent_name
CREATE INDEX IF NOT EXISTS idx_agent_settings_name ON agent_settings(agent_name);

-- Добавляем триггер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_agent_settings_updated_at 
  BEFORE UPDATE ON agent_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Проверка: посмотреть структуру таблицы
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'agent_settings';

