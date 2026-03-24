import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Integer, DateTime, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from app.database import Base

# Job table: tracks queued work items through their full lifecycle
class Job(Base):
    __tablename__ = "jobs"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)                           # UUID PK
    job_type = Column(String(64), nullable=False)                                                   # Identifies the handler
    payload = Column(JSONB, nullable=False)                                                         # Arbitrary job data
    status = Column(String(16), default="pending", index=True)                                      # pending → processing → completed / failed → dead
    priority = Column(Integer, default=5, nullable=False)                                           # 1–3 = high queue, 4–6 = normal, 7–10 = low
    retry_count = Column(Integer, default=0, nullable=False)                                        # Times retried so far
    max_retries = Column(Integer, default=3, nullable=False)                                        # Retry cap
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))        # Timestamp when job was created
    started_at = Column(DateTime(timezone=True), nullable=True)                                     # Set when worker picks up job
    completed_at = Column(DateTime(timezone=True), nullable=True)                                   # Set on success or final failure
    worker_id = Column(String(64), nullable=True)                                                   # ID of the worker handling it
    error_msg = Column(Text, nullable=True)                                                         # Last error message if failed



