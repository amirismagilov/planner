# Planner MVP (Python + React)

Кратко: gantt chart and planning tool for selfhosted Jira.

Первый рабочий MVP-скелет планировщика задач с ручным импортом Jira XML/RSS.

## Реализовано

- Backend: `FastAPI` + `SQLAlchemy` + `SQLite` (файл `backend/planner.db`).
- Импорт Jira: `POST /api/import` (multipart-файл, парсер `lxml.etree.XMLParser(recover=True)`).
- Хранение в БД: `Task`, `TaskLink`, `ImportLog`.
- Поддержка типов задач: `История/Story`, `Tech task`, `Ошибка/Bug`.
- Upsert задач по `jira_key`.
- Merge-логика: на импорте обновляются только `jira_*`, пользовательские поля (`user_*`, `duration_days`) остаются без изменений.
- На выдаче: `title` (ключ + summary из Jira), планирование: `user_start_day`, `user_end_day`, `duration_days`.
- Импорт связей: имя типа связи читается из атрибута `name` элемента `issuelinktype` **или** из дочернего `<name>` (как в типичном Jira RSS). После обновления кода **нужно заново импортировать XML**, иначе в БД могут остаться старые записи с типом `link` и колонки связей будут пустыми.
- Связи в ответе задачи: `blocked_by` (кто блокирует), `blocks` (кого блокирует эта задача) — только для типов `Blocks` / `is blocked*`; `other_links` — остальные (Relates, subtask, Duplicate и т.д.). У каждой связи: ключ, статус из Jira, тип связи.
- Missing-задачи: после импорта ставится `missing_in_source=true`, если задача отсутствует в текущем файле.
- Связи Jira: пересобираются каждый импорт (`origin=jira`), с дедупликацией по `source/target/type`.
- Frontend: русская страница с загрузкой XML, таблицей задач, датами старт/окончание, продолжительностью, hide/unhide.
- PBI (ручные группы): сущность с числовым номером и названием; задача может быть привязана к одному PBI или ни к одному. Список в UI сгруппирован по PBI.

## API MVP

- `POST /api/import` — импорт Jira XML/RSS файла.
- `GET /api/pbis`, `POST /api/pbis`, `PATCH /api/pbis/{id}`, `DELETE /api/pbis/{id}` — управление PBI (номер и название задаются вручную). При удалении PBI задачи не удаляются — с них снимается привязка (`pbi_id`).
- `GET /api/tasks` — список задач (`title`, `pbi_id` / `pbi_number` / `pbi_name`, `blocked_by`, `blocks`, `other_links`, планирование).
- `PATCH /api/tasks/{id}` — обновление полей планирования и `pbi_id` (`null` — убрать из группы).
- `POST /api/tasks/{id}/hide` — скрыть задачу.
- `POST /api/tasks/{id}/unhide` — показать задачу.

## Локальный запуск

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

- Backend API: [http://localhost:8000](http://localhost:8000)
- Swagger: [http://localhost:8000/docs](http://localhost:8000/docs)
- Frontend UI: [http://localhost:5173](http://localhost:5173)

## Минимальная обработка ошибок

- Некорректный файл импорта: понятное сообщение на русском.
- Ошибки чтения/импорта XML: русское сообщение от API.
- Ошибки загрузки/сохранения на фронтенде: отображаются пользователю.
