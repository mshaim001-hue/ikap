# Интеграция pdftopng (финансовая отчётность)

## Обзор

При загрузке финансовой отчётности (PDF) ikap отправляет файлы на сервис **pdftopng** (Render.com), который:
- Конвертирует PDF в PNG
- Анализирует через OpenAI (gpt-4o-mini)
- Возвращает таблицу показателей по годам + краткий анализ

## Настройка

### pdftopng (ikap4-backend)
- URL: `https://ikap4-backend.onrender.com`
- Переменные: `OPENAI_API_KEY`, `OPENAI_MODEL` (опционально)

### ikap
- `FINANCIAL_PDF_SERVICE_URL` — URL pdftopng (уже в render.yaml)

## Приоритет

1. **FINANCIAL_PDF_SERVICE_URL** — если задан, используется pdftopng
2. **PDF_SERVICE_URL** — fallback на Cloud Run OCR + агент

## Формат ответа pdftopng

```
GET /api/analysis/{id}
→ { status, table, years, summary }
```

Результат форматируется в Markdown: краткий анализ + таблица показателей (Выручка, Себестоимость, Расходы, Чистая прибыль, Капитал).
