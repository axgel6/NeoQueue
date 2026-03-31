import asyncio
import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Job
from app.schemas import JobCreate, JobResponse
from app.redis_client import get_redis, queue_key, PRIORITY_QUEUES

router = APIRouter()

# ----- Enqueue Job -----

# POST /jobs: creates a new job record and pushes its ID onto the appropriate Redis priority queue
@router.post("/jobs", response_model=JobResponse, status_code=202)
def enqueue_job(body: JobCreate, db: Session = Depends(get_db)):
    # Persist to DB first so it has an ID before queuing
    job = Job(
        job_type    = body.job_type,
        payload     = body.payload,
        priority    = body.priority,
        max_retries = body.max_retries,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Push job ID to the left of the priority-specific Redis list (workers pop from the right)
    get_redis().lpush(queue_key(body.priority), str(job.id))
    return job

# ----- Get Job -----

# GET /jobs/{job_id}: fetch a single job by its UUID
@router.get("/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

# ----- Stream Job Status -----

# GET /jobs/{job_id}/stream: SSE stream that emits job status updates until terminal state
@router.get("/jobs/{job_id}/stream")
async def stream_job(job_id: UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        TERMINAL_STATES = {"completed", "failed", "dead"}
        last_status = None

        while True:
            # Re-query on each poll to get fresh state (run in thread to avoid blocking event loop)
            await asyncio.to_thread(db.refresh, job)

            if job.status != last_status:
                last_status = job.status

                payload = json.dumps({
                    "job_id":       str(job.id),
                    "status":       job.status,
                    "retry_count":  job.retry_count,
                    "error_msg":    job.error_msg,
                    "started_at":   job.started_at.isoformat()   if job.started_at   else None,
                    "completed_at": job.completed_at.isoformat() if job.completed_at else None,
                })
                yield f"data: {payload}\n\n"

            if job.status in TERMINAL_STATES:
                break

            await asyncio.sleep(1)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# ----- Queue Stats -----

# GET /queue/stats: Redis queue depths + Postgres status counts + alive worker count
@router.get("/queue/stats")
def queue_stats(db: Session = Depends(get_db)):
    r = get_redis()

    # Count alive workers by scanning heartbeat keys (SCAN avoids blocking Redis)
    workers_alive = sum(1 for _ in r.scan_iter("heartbeat:*"))

    return {
        # Number of job IDs currently waiting in each Redis priority queue
        "queues": {name: r.llen(key) for name, key in PRIORITY_QUEUES.items()},
        # Counts of jobs grouped by their current status in Postgres
        "jobs": {
            "pending":    db.query(Job).filter_by(status="pending").count(),
            "processing": db.query(Job).filter_by(status="processing").count(),
            "completed":  db.query(Job).filter_by(status="completed").count(),
            "failed":     db.query(Job).filter_by(status="failed").count(),
            "dead":       db.query(Job).filter_by(status="dead").count(),
        },
        # Number of workers currently alive based on Redis heartbeat keys
        "workers_alive": workers_alive,
    }
