from datetime import datetime
from lxml import etree
from sqlalchemy.orm import Session
import json

from ..models import Task, TaskLink, ImportLog

ALLOWED_TYPES = {"история", "story", "tech task", "ошибка", "bug"}


def _text(el, path: str) -> str:
    node = el.find(path)
    return (node.text or "").strip() if node is not None and node.text else ""


def _link_type_name(lt) -> str:
    """Jira RSS: имя типа часто в атрибуте name, иначе в дочернем элементе <name>."""
    raw = (lt.attrib.get("name") or "").strip()
    if raw:
        return raw
    child = _text(lt, "name")
    if child:
        return child
    return "link"


def _to_float_or_none(raw: str):
    if not raw:
        return None
    try:
        return float(raw.replace(",", "."))
    except ValueError:
        return None


def import_jira_xml(db: Session, file_path: str, file_name: str):
    run = ImportLog(file_name=file_name, status="running")
    db.add(run)
    db.commit()
    db.refresh(run)

    parser = etree.XMLParser(recover=True, huge_tree=True)
    tree = etree.parse(file_path, parser)
    root = tree.getroot()
    items = root.findall(".//item")

    parsed = []
    current_keys = set()
    for item in items:
        key = _text(item, "key")
        if not key:
            continue

        issue_type = _text(item, "type")
        if issue_type.lower() not in ALLOWED_TYPES:
            continue

        current_keys.add(key)
        parsed.append(
            {
                "key": key,
                "summary": _text(item, "summary"),
                "type": issue_type,
                "status": _text(item, "status"),
                "start_day": _text(item, "start"),
                "end_day": _text(item, "due"),
                "progress": _text(item, "progress"),
                "links": item.findall(".//issuelinks/issuelinktype"),
                "subtasks": [
                    (st.text or "").strip()
                    for st in item.findall(".//subtasks/subtask")
                    if (st.text or "").strip()
                ],
            }
        )

    existing = {t.jira_key: t for t in db.query(Task).all()}
    created = 0
    updated = 0

    for row in parsed:
        task = existing.get(row["key"])
        if not task:
            task = Task(
                jira_key=row["key"],
                jira_summary=row["summary"],
                jira_type=row["type"],
                jira_status=row["status"],
                jira_start_day=row["start_day"] or None,
                jira_end_day=row["end_day"] or None,
                jira_progress=_to_float_or_none(row["progress"]),
                missing_in_source=False,
            )
            db.add(task)
            created += 1
        else:
            # Merge rule: never touch user_* fields on import.
            task.jira_summary = row["summary"]
            task.jira_type = row["type"]
            task.jira_status = row["status"]
            task.jira_start_day = row["start_day"] or None
            task.jira_end_day = row["end_day"] or None
            task.jira_progress = _to_float_or_none(row["progress"])
            task.missing_in_source = False
            updated += 1

    db.commit()

    all_tasks = {t.jira_key: t for t in db.query(Task).all()}
    db.query(TaskLink).filter(TaskLink.origin == "jira").delete()
    db.commit()

    link_seen = set()
    link_count = 0
    skipped_links = 0

    for row in parsed:
        source = all_tasks.get(row["key"])
        if not source:
            continue

        for lt in row["links"]:
            name = _link_type_name(lt)
            for out in lt.findall(".//outwardlinks/issuelink/issuekey"):
                target_key = (out.text or "").strip()
                target = all_tasks.get(target_key)
                if not target:
                    skipped_links += 1
                    continue
                sig = (source.id, target.id, name)
                if sig in link_seen:
                    continue
                link_seen.add(sig)
                db.add(TaskLink(source_task_id=source.id, target_task_id=target.id, link_type=name, origin="jira"))
                link_count += 1

            for inn in lt.findall(".//inwardlinks/issuelink/issuekey"):
                source_key = (inn.text or "").strip()
                source_task = all_tasks.get(source_key)
                if not source_task:
                    skipped_links += 1
                    continue
                sig = (source_task.id, source.id, name)
                if sig in link_seen:
                    continue
                link_seen.add(sig)
                db.add(TaskLink(source_task_id=source_task.id, target_task_id=source.id, link_type=name, origin="jira"))
                link_count += 1

        for sub_key in row["subtasks"]:
            target = all_tasks.get(sub_key)
            if not target:
                skipped_links += 1
                continue
            sig = (source.id, target.id, "subtask")
            if sig in link_seen:
                continue
            link_seen.add(sig)
            db.add(TaskLink(source_task_id=source.id, target_task_id=target.id, link_type="subtask", origin="jira"))
            link_count += 1

    for t in db.query(Task).all():
        if t.jira_key not in current_keys:
            t.missing_in_source = True

    stats = {
        "parsed_items": len(parsed),
        "created": created,
        "updated": updated,
        "links": link_count,
        "skipped_links": skipped_links,
    }

    run.status = "success"
    run.stats_json = json.dumps(stats, ensure_ascii=False)
    run.finished_at = datetime.utcnow()

    db.commit()
    return stats
