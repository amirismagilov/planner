from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey, Text, Float, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
from .database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False, default="viewer")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Pbi(Base):
    """Ручной PBI (Product Backlog Item): числовой id и название; к задаче 0..1."""
    __tablename__ = "pbis"

    id = Column(Integer, primary_key=True, index=True)
    number = Column(Integer, nullable=False, unique=True, index=True)
    name = Column(String(500), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    tasks = relationship("Task", back_populates="pbi")


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (UniqueConstraint("jira_key", name="uq_tasks_jira_key"),)

    id = Column(Integer, primary_key=True, index=True)
    jira_key = Column(String(50), nullable=False, index=True)

    jira_summary = Column(Text, nullable=True)
    jira_type = Column(String(80), nullable=True)
    jira_status = Column(String(80), nullable=True)
    jira_start_day = Column(String(20), nullable=True)
    jira_end_day = Column(String(20), nullable=True)
    jira_progress = Column(Float, nullable=True)

    user_start_day = Column(String(20), nullable=True)
    user_end_day = Column(String(20), nullable=True)
    duration_days = Column(Integer, nullable=True)
    user_progress = Column(Float, nullable=True)
    user_note = Column(Text, nullable=True)

    missing_in_source = Column(Boolean, default=False, nullable=False)
    hidden_by_user = Column(Boolean, default=False, nullable=False)

    pbi_id = Column(Integer, ForeignKey("pbis.id", ondelete="SET NULL"), nullable=True, index=True)
    pbi = relationship("Pbi", back_populates="tasks")

    # Порядок строк внутри группы (один PBI или «без группы»); сортировка в UI.
    list_order = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class TaskLink(Base):
    __tablename__ = "task_links"

    id = Column(Integer, primary_key=True, index=True)
    source_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    target_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    link_type = Column(String(120), nullable=False)
    origin = Column(String(20), nullable=False, default="jira")


class ImportLog(Base):
    __tablename__ = "import_logs"

    id = Column(Integer, primary_key=True, index=True)
    file_name = Column(String(255), nullable=False)
    status = Column(String(20), nullable=False, default="running")
    stats_json = Column(Text, nullable=True)
    error_log = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime, nullable=True)
