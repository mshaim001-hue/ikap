-- Миграция для добавления полей role и functionality в таблицу agent_settings
-- Выполните этот SQL в Supabase SQL Editor

-- 1. Добавляем колонку role (роль агента)
ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS role TEXT;

-- 2. Добавляем колонку functionality (функционал агента)
ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS functionality TEXT;

-- 3. Обновляем существующую запись Information Agent с дефолтными значениями
UPDATE agent_settings 
SET 
  role = COALESCE(role, 'Информационный консультант'),
  functionality = COALESCE(functionality, 'Отвечает на вопросы о платформе iKapitalist, помогает пользователям понять возможности платформы и подводит к подаче заявки')
WHERE agent_name = 'Information Agent' AND (role IS NULL OR functionality IS NULL);

-- Проверка: посмотреть структуру таблицы
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'agent_settings';

