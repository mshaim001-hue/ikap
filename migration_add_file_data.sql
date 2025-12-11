-- Миграция для добавления колонки file_data и UNIQUE constraint на file_id
-- Выполните этот SQL в Supabase SQL Editor

-- 1. Добавляем колонку file_data (если её еще нет)
ALTER TABLE files ADD COLUMN IF NOT EXISTS file_data BYTEA;

-- 2. Добавляем UNIQUE constraint на file_id (если его еще нет)
-- Сначала проверяем, существует ли уже constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'files_file_id_key' 
        AND conrelid = 'files'::regclass
    ) THEN
        ALTER TABLE files ADD CONSTRAINT files_file_id_key UNIQUE (file_id);
    END IF;
END $$;

-- Проверка: посмотреть структуру таблицы
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'files';

