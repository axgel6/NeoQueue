import uuid
from datetime import datetime, timezone
from typing import Any, Optional
from sqlalchemy import String, Integer, DateTime, Text, CheckConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base

# Job table: tracks queued work items through their full lifecycle
class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'processing', 'completed', 'failed', 'dead')",
            name="valid_status"
        ),
    )

    id:           Mapped[uuid.UUID]         = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)           # UUID PK
    job_type:     Mapped[str]               = mapped_column(String(64), nullable=False)                                           # Identifies the handler
    payload:      Mapped[dict[str, Any]]    = mapped_column(JSONB, nullable=False)                                                # Arbitrary job data
    status:       Mapped[str]               = mapped_column(String(16), default="pending", index=True)                            # pending → processing → completed / failed → dead
    priority:     Mapped[int]               = mapped_column(Integer, default=5, nullable=False)                                   # 1–3 = high queue, 4–6 = normal, 7–10 = low
    retry_count:  Mapped[int]               = mapped_column(Integer, default=0, nullable=False)                                   # Times retried so far
    max_retries:  Mapped[int]               = mapped_column(Integer, default=3, nullable=False)                                   # Retry cap
    created_at:   Mapped[datetime]          = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))  # Timestamp when job was created
    started_at:   Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)                              # Set when worker picks up job
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)                              # Set on success or final failure
    worker_id:    Mapped[Optional[str]]     = mapped_column(String(64), nullable=True)                                            # ID of the worker handling it
    error_msg:    Mapped[Optional[str]]     = mapped_column(Text, nullable=True)                                                  # Last error message if failed
