import os
import re
import pdfplumber
from flask import Flask, request, render_template, redirect, url_for, flash, send_file
from io import BytesIO
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

# Создаем папку для загрузок, если её нет
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

ALLOWED_EXTENSIONS = {'pdf'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# Словарь для исправления слипшихся слов
from word_fixes import WORD_FIXES

def fix_merged_words(text):
    """Исправляет слипшиеся слова, заменяя их на правильные версии с пробелами"""
    result = text
    # Сортируем по длине (от длинных к коротким), чтобы сначала заменять более длинные паттерны
    sorted_fixes = sorted(WORD_FIXES.items(), key=lambda x: len(x[0]), reverse=True)
    
    for merged, fixed in sorted_fixes:
        # Заменяем все вхождения слипшегося слова на правильную версию
        result = result.replace(merged, fixed)
    
    return result

def normalize_text(text):
    """
    Нормализует текст, убирая лишние пробелы между символами.
    Объединяет разделенные пробелами цифры и буквы в слова.
    """
    if not text:
        return text
    
    # ШАГ 1: Сохраняем границы между словами (чтобы не потерять их при объединении)
    # Строчная -> заглавная = новое слово (для кириллицы и латиницы)
    text = re.sub(r'([а-яё])\s+([А-ЯЁ])', r'\1||WORD_BOUNDARY||\2', text)
    text = re.sub(r'([a-z])\s+([A-Z])', r'\1||WORD_BOUNDARY||\2', text)
    
    # Обрабатываем последовательности заглавных букв через пробел
    # Если после последовательности заглавных идет строчная, то последняя заглавная начинает новое слово
    # Например: "И П М е" -> граница между "П" и "М", чтобы получить "ИП Ме"
    # Ищем паттерн: заглавная пробел заглавная пробел заглавная пробел строчная
    text = re.sub(r'([А-ЯЁ])\s+([А-ЯЁ])\s+([А-ЯЁ])(?=\s+[а-яё])', r'\1\2||WORD_BOUNDARY||\3', text)
    text = re.sub(r'([A-Z])\s+([A-Z])\s+([A-Z])(?=\s+[a-z])', r'\1\2||WORD_BOUNDARY||\3', text)
    
    # Буква -> цифра и цифра -> буква = граница
    text = re.sub(r'([А-Яа-яЁёA-Za-z])\s+(\d)', r'\1||WORD_BOUNDARY||\2', text)
    text = re.sub(r'(\d)\s+([А-Яа-яЁёA-Za-z])', r'\1||WORD_BOUNDARY||\2', text)
    
    # ШАГ 2: Объединяем все цифры, разделенные пробелами
    changed = True
    while changed:
        new_text = re.sub(r'(\d)\s+(\d)', r'\1\2', text)
        changed = (new_text != text)
        text = new_text
    
    # ШАГ 3: Объединяем буквы кириллицы, разделенные пробелами
    changed = True
    while changed:
        new_text = text
        # Объединяем строчные буквы
        new_text = re.sub(r'([а-яё])\s+([а-яё])', r'\1\2', new_text)
        # Объединяем заглавные буквы (могут быть аббревиатуры типа "ИП", "БИН")
        new_text = re.sub(r'([А-ЯЁ])\s+([А-ЯЁ])', r'\1\2', new_text)
        # Объединяем заглавную со строчной (начало слова)
        new_text = re.sub(r'([А-ЯЁ])\s+([а-яё])', r'\1\2', new_text)
        changed = (new_text != text)
        text = new_text
    
    # ШАГ 4: Объединяем латинские буквы
    changed = True
    while changed:
        new_text = text
        new_text = re.sub(r'([a-z])\s+([a-z])', r'\1\2', new_text)
        new_text = re.sub(r'([A-Z])\s+([A-Z])', r'\1\2', new_text)
        new_text = re.sub(r'([A-Z])\s+([a-z])', r'\1\2', new_text)
        changed = (new_text != text)
        text = new_text
    
    # ШАГ 5: Восстанавливаем пробелы на границах слов
    text = re.sub(r'\|\|WORD_BOUNDARY\|\|', ' ', text)
    
    # ШАГ 6: Исправляем точки и запятые в числах (например: "9 1 0 . 0 0" -> "910.00")
    text = re.sub(r'(\d)\s+([.,])\s+(\d)', r'\1\2\3', text)
    text = re.sub(r'(\d)\s+([.,])\s*(\d)', r'\1\2\3', text)
    text = re.sub(r'(\d)\s*([.,])\s+(\d)', r'\1\2\3', text)
    
    # ШАГ 7: Обрабатываем даты (dd.mm.yyyy или dd.mm.yy, где mm < 12)
    # Находим паттерны дат ВЕЗДЕ (даже внутри других чисел) и добавляем пробелы перед и после них
    
    # Ищем все возможные даты в тексте БЕЗ границ слов
    # Используем регулярное выражение для поиска всех паттернов дат
    def find_all_dates(text_ref):
        """Находит все даты в тексте и добавляет пробелы вокруг них"""
        # Ищем все паттерны вида dd.mm.yyyy или dd.mm.yy
        # БЕЗ использования границ слов, чтобы находить даты внутри чисел
        date_pattern = r'(\d{1,2})\.(\d{1,2})\.(\d{2,4})'
        
        matches = list(re.finditer(date_pattern, text_ref))
        
        # Собираем все валидные даты с их позициями
        valid_dates = []
        for match in matches:
            day_str = match.group(1)
            month_str = match.group(2)
            year_str = match.group(3)
            
            try:
                day = int(day_str)
                month = int(month_str)
                
                # Проверяем, что месяц валидный (1-12) и день валидный (1-31)
                if 1 <= month <= 12 and 1 <= day <= 31:
                    valid_dates.append((match.start(), match.end(), match.group(0)))
            except ValueError:
                pass
        
        # Сортируем по позиции начала (с конца, чтобы не сбить индексы при вставке)
        valid_dates.sort(key=lambda x: x[0], reverse=True)
        
        # Обрабатываем даты с конца, чтобы не сбить индексы при вставке
        result = list(text_ref)
        
        for start, end, date_str in valid_dates:
            # Вычисляем актуальные позиции с учетом уже вставленных пробелов
            # (так как мы обрабатываем с конца, предыдущие вставки не влияют)
            actual_start = start
            actual_end = end
            
            # Добавляем пробел перед датой, если его нет
            if actual_start > 0 and result[actual_start - 1] not in ' \n\t':
                result.insert(actual_start, ' ')
                actual_start += 1
                actual_end += 1
            
            # Добавляем пробел после даты, если его нет
            if actual_end < len(result) and result[actual_end] not in ' \n\t':
                result.insert(actual_end, ' ')
        
        return ''.join(result)
    
    # Применяем поиск и форматирование дат
    text = find_all_dates(text)
    
    # ШАГ 7.5: Обрабатываем номера формата 100.xx.yyy (коды строк в налоговых декларациях)
    # Находим паттерны вида 100.xx.yyy и добавляем пробелы перед и после них
    def find_tax_codes(text_ref):
        """Находит номера формата 100.xx.yyy и добавляет пробелы вокруг них"""
        # Ищем паттерн: 100. две цифры . три цифры
        tax_code_pattern = r'100\.(\d{2})\.(\d{3})'
        
        matches = list(re.finditer(tax_code_pattern, text_ref))
        
        # Обрабатываем с конца, чтобы не сбить индексы
        valid_codes = []
        for match in matches:
            code_str = match.group(0)  # Полный код, например "100.02.001"
            start = match.start()
            end = match.end()
            valid_codes.append((start, end, code_str))
        
        # Сортируем по позиции начала (с конца)
        valid_codes.sort(key=lambda x: x[0], reverse=True)
        
        # Обрабатываем коды с конца
        result = list(text_ref)
        
        for start, end, code_str in valid_codes:
            actual_start = start
            actual_end = end
            
            # Добавляем пробел перед кодом, если его нет
            if actual_start > 0 and result[actual_start - 1] not in ' \n\t':
                result.insert(actual_start, ' ')
                actual_start += 1
                actual_end += 1
            
            # Добавляем пробел после кода, если его нет и после него идут цифры
            if actual_end < len(result):
                # Проверяем, что после кода идут цифры (не пробел, не буква)
                if result[actual_end].isdigit():
                    result.insert(actual_end, ' ')
                    actual_end += 1
                elif result[actual_end] not in ' \n\t':
                    # Если после кода не пробел и не цифра, тоже добавляем пробел
                    result.insert(actual_end, ' ')
        
        return ''.join(result)
    
    # Применяем поиск и форматирование налоговых кодов
    text = find_tax_codes(text)
    
    # Также обрабатываем случаи, когда дата может быть написана как "15082025" (8 цифр подряд)
    # Преобразуем в формат "15.08.2025" если это похоже на дату
    def make_8digit_replacer(text_ref):
        def process_8digit_date(match):
            """Обрабатывает 8-значные числа, которые могут быть датами"""
            digits = match.group(0)
            if len(digits) == 8:
                try:
                    day = int(digits[0:2])
                    month = int(digits[2:4])
                    year = digits[4:8]
                    
                    # Проверяем, что это валидная дата
                    if 1 <= month <= 12 and 1 <= day <= 31:
                        date_str = f"{digits[0:2]}.{digits[2:4]}.{year}"
                        
                        # Получаем позиции
                        start = match.start()
                        end = match.end()
                        
                        # Добавляем пробелы
                        if start > 0 and text_ref[start-1] not in ' \n\t':
                            date_str = ' ' + date_str
                        if end < len(text_ref) and text_ref[end] not in ' \n\t':
                            date_str = date_str + ' '
                        
                        return date_str
                except ValueError:
                    pass
            
            return digits
        return process_8digit_date
    
    # Ищем 8-значные числа, которые могут быть датами (но только если они не часть большего числа)
    # Используем границы слов, чтобы не трогать числа в середине других чисел
    text = re.sub(r'\b(\d{8})\b', make_8digit_replacer(text), text)
    
    # ШАГ 8: Исправляем пробелы вокруг знаков препинания
    text = re.sub(r'\s+([.,;:!?])', r'\1', text)
    text = re.sub(r'([.,;:!?])\s+', r'\1 ', text)
    
    # ШАГ 9: Исправляем слипшиеся слова
    text = fix_merged_words(text)
    
    # ШАГ 10: Убираем множественные пробелы, оставляя один
    text = re.sub(r' {2,}', ' ', text)
    
    return text

def parse_pdf(filepath):
    """Парсит PDF файл и возвращает извлеченный текст"""
    extracted_text = []
    try:
        with pdfplumber.open(filepath) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    extracted_text.append(text)
    except Exception as e:
        return None, str(e)
    
    # Объединяем весь текст
    full_text = '\n\n'.join(extracted_text)
    
    # Нормализуем текст (убираем лишние пробелы)
    normalized_text = normalize_text(full_text)
    
    return normalized_text, None

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        flash('Файлы не выбраны')
        return redirect(url_for('index'))
    
    files = request.files.getlist('file')
    
    if not files or all(f.filename == '' for f in files):
        flash('Файлы не выбраны')
        return redirect(url_for('index'))
    
    results = []
    errors = []
    
    for file in files:
        if file.filename == '':
            continue
            
        if not allowed_file(file.filename):
            errors.append(f'{file.filename}: не является PDF файлом')
            continue
        
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        
        try:
            file.save(filepath)
            
            # Парсим PDF
            text, error = parse_pdf(filepath)
            
            # Удаляем файл после парсинга
            try:
                os.remove(filepath)
            except:
                pass
            
            if error:
                errors.append(f'{filename}: {error}')
            else:
                results.append({
                    'filename': filename,
                    'text': text
                })
        except Exception as e:
            errors.append(f'{filename}: ошибка обработки - {str(e)}')
            # Пытаемся удалить файл в случае ошибки
            try:
                if os.path.exists(filepath):
                    os.remove(filepath)
            except:
                pass
    
    if errors:
        for error in errors:
            flash(error)
    
    if not results:
        return redirect(url_for('index'))
    
    # Объединяем все результаты в один текст
    combined_text_parts = []
    filenames = []
    
    for result in results:
        filenames.append(result['filename'])
        # Добавляем разделитель с именем файла
        combined_text_parts.append(f"\n{'='*80}\n")
        combined_text_parts.append(f"ФАЙЛ: {result['filename']}\n")
        combined_text_parts.append(f"{'='*80}\n\n")
        combined_text_parts.append(result['text'])
        combined_text_parts.append("\n\n")
    
    combined_text = ''.join(combined_text_parts)
    
    # Формируем имя файла для скачивания
    if len(results) == 1:
        download_filename = results[0]['filename']
    else:
        # Используем имя первого файла с префиксом "combined"
        base_name = results[0]['filename'].replace('.pdf', '')
        download_filename = f"combined_{base_name}_and_{len(results)-1}_more.pdf"
    
    # Сохраняем объединенный текст в сессии для скачивания
    # (в реальном приложении лучше использовать кеш или БД)
    # Для простоты передаем через параметр в шаблоне
    
    return render_template('result.html', 
                         text=combined_text, 
                         filename=download_filename,
                         file_count=len(results),
                         filenames=filenames)

@app.route('/download', methods=['POST'])
def download_file():
    """Endpoint для скачивания файла через сервер"""
    text = request.form.get('text', '')
    filename = request.form.get('filename', 'parsed_result.txt')
    
    if not text:
        flash('Текст для скачивания пуст')
        return redirect(url_for('index'))
    
    # Формируем имя файла
    if filename.endswith('.pdf'):
        txt_filename = filename.replace('.pdf', '_parsed.txt')
    else:
        txt_filename = filename.replace('.pdf', '') + '_parsed.txt'
    
    # Создаем BytesIO объект с текстом
    output = BytesIO()
    output.write(text.encode('utf-8'))
    output.seek(0)
    
    return send_file(
        output,
        mimetype='text/plain',
        as_attachment=True,
        download_name=txt_filename
    )

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)

