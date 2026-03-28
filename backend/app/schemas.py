from pydantic import BaseModel
from typing import Optional, List


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class RelatedTaskBrief(BaseModel):
    jira_key: str
    jira_status: Optional[str]
    summary: Optional[str]
    link_type: str


class TaskUpdateRequest(BaseModel):
    user_start_day: Optional[str] = None
    user_end_day: Optional[str] = None
    duration_days: Optional[int] = None
    user_progress: Optional[float] = None
    user_note: Optional[str] = None
    hidden_by_user: Optional[bool] = None
    pbi_id: Optional[int] = None


class PbiCreate(BaseModel):
    number: int
    name: str


class PbiUpdate(BaseModel):
    number: Optional[int] = None
    name: Optional[str] = None


class PbiResponse(BaseModel):
    id: int
    number: int
    name: str

    class Config:
        from_attributes = True


class TaskResponse(BaseModel):
    id: int
    jira_key: str
    jira_summary: Optional[str]
    jira_type: Optional[str]
    jira_status: Optional[str]
    jira_start_day: Optional[str]
    jira_end_day: Optional[str]
    jira_progress: Optional[float]
    title: str
    user_start_day: Optional[str]
    user_end_day: Optional[str]
    duration_days: Optional[int]
    user_progress: Optional[float]
    user_note: Optional[str]
    missing_in_source: bool
    hidden_by_user: bool
    pbi_id: Optional[int] = None
    pbi_number: Optional[int] = None
    pbi_name: Optional[str] = None
    blocked_by: List[RelatedTaskBrief]
    blocks: List[RelatedTaskBrief]
    other_links: List[RelatedTaskBrief]

    class Config:
        from_attributes = True


class LinkResponse(BaseModel):
    source_task_id: int
    target_task_id: int
    link_type: str

    class Config:
        from_attributes = True
