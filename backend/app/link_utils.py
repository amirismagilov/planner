"""Классификация типов связей Jira (Blocks vs прочие)."""


def is_jira_blocks_link_type(link_type: str) -> bool:
    """
    Связь блокировки: тип связи в Jira обычно называется «Blocks»;
    в некоторых выгрузках встречается текст inward «is blocked by».
    """
    t = (link_type or "").strip().lower()
    if not t:
        return False
    if "duplicate" in t or "clone" in t:
        return False
    if t == "relates" or t.startswith("relates"):
        return False
    if t == "blocks":
        return True
    if "is blocked" in t:
        return True
    return False
