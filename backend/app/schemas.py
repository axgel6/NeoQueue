from uuid import UUID
from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, Field


# Request body schema for creating a new job
class JobCreate(BaseModel):
    job_type: str = Field(..., max_length=64)           # Identifies which worker handler to invoke
    payload: dict[str, Any]                             # Arbitrary job data passed to the worker
    priority: int = Field(default=5, ge=1, le=10)       # 1–3 = high queue, 4–6 = normal, 7–10 = low; default mid-range
    max_retries: int = Field(default=3, ge=0, le=10)    # How many times to retry on failure


# Response schema returned by the API for any job read/write operation
class JobResponse(BaseModel):
    id: UUID
    job_type: str
    payload: dict[str, Any]
    status: str                      # e.g. "pending", "processing", "completed", "failed", "dead"
    priority: int
    retry_count: int                 # Number of attempts made so far
    max_retries: int
    created_at: Optional[datetime]
    started_at: Optional[datetime]   # Set when a worker picks up the job
    completed_at: Optional[datetime] # Set on success or permanent failure
    worker_id: Optional[str]         # ID of the worker that processed the job
    error_msg: Optional[str]         # Last error message if the job failed
    model_config = {"from_attributes": True}  # Allows constructing from ORM model instances