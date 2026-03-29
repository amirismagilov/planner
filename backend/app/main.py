from fastapi import FastAPI, Depends, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import text, inspect
import os
import tempfile

from .database import Base, engine, get_db
from .models import User, Task, TaskLink, ImportLog, Pbi
from .schemas import (
    LoginRequest,
    TokenResponse,
    TaskUpdateRequest,
    TaskReorderRequest,
    TaskResponse,
    LinkResponse,
    RelatedTaskBrief,
    PbiCreate,
    PbiUpdate,
    PbiResponse,
)
from .auth import verify_password, hash_password, create_access_token, get_current_user, require_editor
from .services.jira_import import import_jira_xml
from .link_utils import is_jira_blocks_link_type


def migrate_schema():
    inspector = inspect(engine)
    if "tasks" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("tasks")}
    dialect = engine.dialect.name
    if "duration_days" not in cols:
        with engine.begin() as conn:
            if dialect == "postgresql":
                conn.execute(text("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duration_days INTEGER"))
            else:
                conn.execute(text("ALTER TABLE tasks ADD COLUMN duration_days INTEGER"))


def migrate_list_order_schema():
    inspector = inspect(engine)
    if "tasks" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("tasks")}
    if "list_order" in cols:
        return
    dialect = engine.dialect.name
    with engine.begin() as conn:
        if dialect == "postgresql":
            conn.execute(text("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS list_order INTEGER NOT NULL DEFAULT 0"))
        else:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN list_order INTEGER NOT NULL DEFAULT 0"))


def migrate_pbi_schema():
    """Существующие БД без таблицы pbis / колонки pbi_id."""
    inspector = inspect(engine)
    dialect = engine.dialect.name
    tables = inspector.get_table_names()
    if "pbis" not in tables:
        Pbi.__table__.create(bind=engine, checkfirst=True)
    if "tasks" not in tables:
        return
    cols = {c["name"] for c in inspector.get_columns("tasks")}
    if "pbi_id" in cols:
        return
    with engine.begin() as conn:
        if dialect == "postgresql":
            conn.execute(
                text(
                    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pbi_id INTEGER "
                    "REFERENCES pbis(id) ON DELETE SET NULL"
                )
            )
        else:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN pbi_id INTEGER"))


def _related_brief(ot: Task, link_type: str) -> RelatedTaskBrief:
    return RelatedTaskBrief(
        jira_key=ot.jira_key,
        jira_status=ot.jira_status,
        summary=(ot.jira_summary or "")[:200] or None,
        link_type=link_type,
    )


def collect_task_relations(
    db: Session, tasks: list[Task]
) -> dict[int, tuple[list[RelatedTaskBrief], list[RelatedTaskBrief], list[RelatedTaskBrief]]]:
    """
    В БД ребро (source, target): source блокирует target для типа Blocks (см. импорт Jira).
    - blocked_by: кто блокирует эту задачу
    - blocks: кого блокирует эта задача
    - other_links: остальные связи (Relates, subtask, Duplicate и т.д.)
    """
    if not tasks:
        return {}
    ids = [t.id for t in tasks]
    task_map: dict[int, Task] = {t.id: t for t in tasks}
    links = (
        db.query(TaskLink)
        .filter((TaskLink.source_task_id.in_(ids)) | (TaskLink.target_task_id.in_(ids)))
        .all()
    )
    extra_ids: set[int] = set()
    for link in links:
        if link.source_task_id not in task_map:
            extra_ids.add(link.source_task_id)
        if link.target_task_id not in task_map:
            extra_ids.add(link.target_task_id)
    if extra_ids:
        for t in db.query(Task).filter(Task.id.in_(extra_ids)).all():
            task_map[t.id] = t

    out: dict[
        int, tuple[list[RelatedTaskBrief], list[RelatedTaskBrief], list[RelatedTaskBrief]]
    ] = {}
    for tid in ids:
        blocked_by: list[RelatedTaskBrief] = []
        blocks: list[RelatedTaskBrief] = []
        other_links: list[RelatedTaskBrief] = []
        seen_by: set[str] = set()
        seen_blocks: set[str] = set()
        seen_other: set[tuple[str, str]] = set()
        for link in links:
            s, t = link.source_task_id, link.target_task_id
            if tid not in (s, t):
                continue
            other_id = t if s == tid else s
            ot = task_map.get(other_id)
            if not ot:
                continue
            brief = _related_brief(ot, link.link_type)
            if is_jira_blocks_link_type(link.link_type):
                if t == tid and ot.jira_key not in seen_by:
                    seen_by.add(ot.jira_key)
                    blocked_by.append(brief)
                elif s == tid and ot.jira_key not in seen_blocks:
                    seen_blocks.add(ot.jira_key)
                    blocks.append(brief)
            else:
                key = (ot.jira_key, link.link_type)
                if key not in seen_other:
                    seen_other.add(key)
                    other_links.append(brief)
        out[tid] = (blocked_by, blocks, other_links)
    return out


def task_title(task: Task) -> str:
    return f"{task.jira_key} {task.jira_summary or ''}".strip()

app = FastAPI(title="Planner API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    migrate_schema()
    migrate_pbi_schema()
    migrate_list_order_schema()
    with next(get_db()) as db:
        user = db.query(User).filter(User.username == "admin").first()
        if not user:
            db.add(User(username="admin", password_hash=hash_password("admin"), role="editor"))
            db.commit()


@app.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.post("/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == payload.username).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    token = create_access_token(user.username)
    return TokenResponse(access_token=token)


def to_task_response(
    task: Task,
    blocked_by: list[RelatedTaskBrief],
    blocks: list[RelatedTaskBrief],
    other_links: list[RelatedTaskBrief],
) -> TaskResponse:
    pbi = task.pbi if task.pbi else None
    return TaskResponse(
        id=task.id,
        jira_key=task.jira_key,
        jira_summary=task.jira_summary,
        jira_type=task.jira_type,
        jira_status=task.jira_status,
        jira_start_day=task.jira_start_day,
        jira_end_day=task.jira_end_day,
        jira_progress=task.jira_progress,
        title=task_title(task),
        user_start_day=task.user_start_day,
        user_end_day=task.user_end_day,
        duration_days=task.duration_days,
        user_progress=task.user_progress,
        user_note=task.user_note,
        missing_in_source=task.missing_in_source,
        hidden_by_user=task.hidden_by_user,
        pbi_id=task.pbi_id,
        pbi_number=pbi.number if pbi else None,
        pbi_name=pbi.name if pbi else None,
        list_order=task.list_order,
        blocked_by=blocked_by,
        blocks=blocks,
        other_links=other_links,
    )


def build_task_responses(db: Session, tasks: list[Task]) -> list[TaskResponse]:
    rel = collect_task_relations(db, tasks)
    return [to_task_response(t, *rel[t.id]) for t in tasks]


def _valid_pbi_ids_set(db: Session) -> set[int]:
    return {p.id for p in db.query(Pbi).all()}


def _effective_pbi_id(task: Task, valid: set[int]) -> int | None:
    if task.pbi_id is None or task.pbi_id not in valid:
        return None
    return task.pbi_id


def _max_list_order_in_group(
    db: Session, valid: set[int], group_eff: int | None, exclude_id: int
) -> int:
    rows = db.query(Task).filter(Task.hidden_by_user == False, Task.id != exclude_id).all()
    in_group = [t for t in rows if _effective_pbi_id(t, valid) == group_eff]
    if not in_group:
        return -1
    return max(t.list_order for t in in_group)


@app.get("/tasks", response_model=list[TaskResponse])
def get_tasks(include_hidden: bool = False, db: Session = Depends(get_db), _user=Depends(get_current_user)):
    q = db.query(Task).options(joinedload(Task.pbi))
    if not include_hidden:
        q = q.filter(Task.hidden_by_user == False)
    tasks = q.order_by(Task.jira_key.asc()).all()
    return build_task_responses(db, tasks)


@app.patch("/tasks/{task_id}", response_model=TaskResponse)
def update_task(task_id: int, payload: TaskUpdateRequest, db: Session = Depends(get_db), _editor=Depends(require_editor)):
    task = db.query(Task).options(joinedload(Task.pbi)).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Задача не найдена")

    data = payload.dict(exclude_unset=True)
    if "pbi_id" in data and data["pbi_id"] is not None:
        pbi = db.query(Pbi).filter(Pbi.id == data["pbi_id"]).first()
        if not pbi:
            raise HTTPException(status_code=404, detail="PBI не найден")
    for k, v in data.items():
        setattr(task, k, v)

    db.commit()
    db.refresh(task)
    task = db.query(Task).options(joinedload(Task.pbi)).filter(Task.id == task_id).first()
    rel = collect_task_relations(db, [task])
    return to_task_response(task, *rel[task.id])


@app.get("/links", response_model=list[LinkResponse])
def get_links(db: Session = Depends(get_db), _user=Depends(get_current_user)):
    return db.query(TaskLink).all()


@app.post("/imports/jira-file")
def import_file(file: UploadFile = File(...), db: Session = Depends(get_db), _editor=Depends(require_editor)):
    if not file.filename.lower().endswith((".xml", ".txt")):
        raise HTTPException(status_code=400, detail="Нужен XML/RSS файл")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".xml") as tmp:
        tmp.write(file.file.read())
        tmp_path = tmp.name

    try:
        stats = import_jira_xml(db, tmp_path, file.filename)
        return {"message": "Импорт завершен", "stats": stats}
    except Exception as e:
        db.add(ImportLog(file_name=file.filename, status="failed", error_log=str(e)))
        db.commit()
        raise HTTPException(status_code=500, detail=f"Ошибка импорта: {e}")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.get("/imports")
def list_imports(db: Session = Depends(get_db), _user=Depends(get_current_user)):
    rows = db.query(ImportLog).order_by(ImportLog.id.desc()).limit(30).all()
    return [
        {
            "id": r.id,
            "file_name": r.file_name,
            "status": r.status,
            "stats_json": r.stats_json,
            "error_log": r.error_log,
            "created_at": r.created_at,
            "finished_at": r.finished_at,
        }
        for r in rows
    ]


@app.post("/api/import")
def api_import(file: UploadFile = File(...), db: Session = Depends(get_db)):
    if not file.filename or not file.filename.lower().endswith((".xml", ".rss", ".txt")):
        raise HTTPException(status_code=400, detail="Нужен корректный Jira XML/RSS файл")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".xml") as tmp:
        tmp.write(file.file.read())
        tmp_path = tmp.name

    try:
        stats = import_jira_xml(db, tmp_path, file.filename)
        return {"message": "Импорт Jira выполнен", "stats": stats}
    except Exception as exc:
        db.add(ImportLog(file_name=file.filename, status="failed", error_log=str(exc)))
        db.commit()
        raise HTTPException(status_code=500, detail="Ошибка импорта Jira XML/RSS")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.get("/api/pbis", response_model=list[PbiResponse])
def api_list_pbis(db: Session = Depends(get_db)):
    return db.query(Pbi).order_by(Pbi.number.asc()).all()


@app.post("/api/pbis", response_model=PbiResponse)
def api_create_pbi(payload: PbiCreate, db: Session = Depends(get_db)):
    if db.query(Pbi).filter(Pbi.number == payload.number).first():
        raise HTTPException(status_code=400, detail="PBI с таким номером уже существует")
    p = Pbi(number=payload.number, name=payload.name.strip())
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@app.patch("/api/pbis/{pbi_id}", response_model=PbiResponse)
def api_update_pbi(pbi_id: int, payload: PbiUpdate, db: Session = Depends(get_db)):
    p = db.query(Pbi).filter(Pbi.id == pbi_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="PBI не найден")
    data = payload.dict(exclude_unset=True)
    if "number" in data:
        if db.query(Pbi).filter(Pbi.number == data["number"], Pbi.id != pbi_id).first():
            raise HTTPException(status_code=400, detail="PBI с таким номером уже существует")
        p.number = data["number"]
    if "name" in data:
        p.name = data["name"].strip()
    db.commit()
    db.refresh(p)
    return p


@app.delete("/api/pbis/{pbi_id}")
def api_delete_pbi(pbi_id: int, db: Session = Depends(get_db)):
    p = db.query(Pbi).filter(Pbi.id == pbi_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="PBI не найден")
    # Явно снимаем связь: задачи не удаляются (и для SQLite без строгого FK)
    db.query(Task).filter(Task.pbi_id == pbi_id).update({Task.pbi_id: None}, synchronize_session=False)
    db.delete(p)
    db.commit()
    return {"ok": True}


@app.get("/api/tasks", response_model=list[TaskResponse])
def api_get_tasks(include_hidden: bool = True, db: Session = Depends(get_db)):
    query = db.query(Task).options(joinedload(Task.pbi))
    if not include_hidden:
        query = query.filter(Task.hidden_by_user == False)
    tasks = query.order_by(Task.jira_key.asc()).all()
    return build_task_responses(db, tasks)


@app.post("/api/tasks/reorder")
def api_reorder_task(payload: TaskReorderRequest, db: Session = Depends(get_db)):
    """Порядок строк в группе и смена PBI (DnD)."""
    valid = _valid_pbi_ids_set(db)
    moving = (
        db.query(Task).filter(Task.id == payload.task_id, Task.hidden_by_user == False).first()
    )
    if not moving:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    if payload.target_pbi_id is not None and payload.target_pbi_id not in valid:
        raise HTTPException(status_code=404, detail="PBI не найден")
    if payload.before_task_id is not None and payload.before_task_id == payload.task_id:
        raise HTTPException(status_code=400, detail="Некорректная цель вставки")

    all_visible = db.query(Task).filter(Task.hidden_by_user == False).all()
    old_eff = _effective_pbi_id(moving, valid)

    if old_eff != payload.target_pbi_id:
        others_old = [
            t
            for t in all_visible
            if t.id != moving.id and _effective_pbi_id(t, valid) == old_eff
        ]
        others_old.sort(key=lambda t: (t.list_order, t.jira_key))
        for i, t in enumerate(others_old):
            t.list_order = i

    moving.pbi_id = payload.target_pbi_id
    new_eff = payload.target_pbi_id

    new_group = [
        t
        for t in all_visible
        if t.id != moving.id and _effective_pbi_id(t, valid) == new_eff
    ]
    new_group.sort(key=lambda t: (t.list_order, t.jira_key))

    if payload.before_task_id is not None:
        idx = next((i for i, t in enumerate(new_group) if t.id == payload.before_task_id), None)
        if idx is None:
            raise HTTPException(
                status_code=400,
                detail="Задача для вставки перед ней не найдена в целевой группе",
            )
        new_group.insert(idx, moving)
    else:
        new_group.append(moving)

    for i, t in enumerate(new_group):
        t.list_order = i

    db.commit()
    return {"ok": True}


@app.patch("/api/tasks/{task_id}", response_model=TaskResponse)
def api_patch_task(task_id: int, payload: TaskUpdateRequest, db: Session = Depends(get_db)):
    task = db.query(Task).options(joinedload(Task.pbi)).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Задача не найдена")

    allowed = {"user_start_day", "user_end_day", "duration_days", "user_progress", "user_note", "pbi_id"}
    data = payload.dict(exclude_unset=True)
    valid = _valid_pbi_ids_set(db)
    old_eff = _effective_pbi_id(task, valid)
    for key, value in data.items():
        if key not in allowed:
            continue
        if key == "pbi_id" and value is not None:
            pbi = db.query(Pbi).filter(Pbi.id == value).first()
            if not pbi:
                raise HTTPException(status_code=404, detail="PBI не найден")
        setattr(task, key, value)

    if "pbi_id" in data:
        new_eff = _effective_pbi_id(task, valid)
        if old_eff != new_eff:
            task.list_order = _max_list_order_in_group(db, valid, new_eff, task.id) + 1

    db.commit()
    task = db.query(Task).options(joinedload(Task.pbi)).filter(Task.id == task_id).first()
    rel = collect_task_relations(db, [task])
    return to_task_response(task, *rel[task.id])


@app.post("/api/tasks/{task_id}/hide", response_model=TaskResponse)
def api_hide_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    task.hidden_by_user = True
    db.commit()
    task = db.query(Task).options(joinedload(Task.pbi)).filter(Task.id == task_id).first()
    rel = collect_task_relations(db, [task])
    return to_task_response(task, *rel[task.id])


@app.post("/api/tasks/{task_id}/unhide", response_model=TaskResponse)
def api_unhide_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    task.hidden_by_user = False
    db.commit()
    task = db.query(Task).options(joinedload(Task.pbi)).filter(Task.id == task_id).first()
    rel = collect_task_relations(db, [task])
    return to_task_response(task, *rel[task.id])
