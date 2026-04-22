import asyncio
import json
from uuid import UUID

from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.models import Job
from app.schemas import JobCreate, JobResponse
from app.redis_client import get_redis, queue_key, PRIORITY_QUEUES

router = APIRouter()

# ----- Enqueue Job -----

@router.post("/jobs", response_model=JobResponse, status_code=202)
def enqueue_job(body: JobCreate, db: Session = Depends(get_db)):
    job = Job(
        job_type    = body.job_type,
        payload     = body.payload,
        priority    = body.priority,
        max_retries = body.max_retries,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    try:
        get_redis().lpush(queue_key(body.priority), str(job.id))
    except Exception:
        # Keep DB and Redis consistent: remove the job so it isn't orphaned.
        db.delete(job)
        db.commit()
        raise HTTPException(status_code=503, detail="Queue unavailable — job not created")

    return job

# ----- List Jobs -----

@router.get("/jobs", response_model=List[JobResponse])
def list_jobs(
    status: Optional[str] = Query(None, description="Filter by status (pending|processing|completed|failed|dead)"),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    query = db.query(Job)
    if status:
        query = query.filter(Job.status == status)
    return query.order_by(Job.created_at.desc()).limit(limit).all()

# ----- Get Job -----

@router.get("/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

# ----- Stream Job Status -----

@router.get("/jobs/{job_id}/stream")
async def stream_job(job_id: UUID, db: Session = Depends(get_db)):
    if not db.query(Job).filter(Job.id == job_id).first():
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        TERMINAL_STATES = {"completed", "dead"}
        last_status = None

        while True:
            # Use a fresh session each cycle — SQLAlchemy sessions are not
            # thread-safe and asyncio.to_thread uses different OS threads.
            session = SessionLocal()
            try:
                job = session.query(Job).filter(Job.id == job_id).first()
                if job is None:
                    break

                if job.status != last_status:
                    last_status = job.status
                    data = json.dumps({
                        "job_id":       str(job.id),
                        "status":       job.status,
                        "priority":     job.priority,
                        "retry_count":  job.retry_count,
                        "max_retries":  job.max_retries,
                        "worker_id":    job.worker_id,
                        "error_msg":    job.error_msg,
                        "payload":      job.payload,
                        "started_at":   job.started_at.isoformat()   if job.started_at   else None,
                        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
                    })
                    yield f"data: {data}\n\n"

                if last_status in TERMINAL_STATES:
                    break
            finally:
                session.close()

            await asyncio.sleep(1)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# ----- Retry Job -----

@router.post("/jobs/{job_id}/retry", response_model=JobResponse)
def retry_job(job_id: UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status not in ("failed", "dead"):
        raise HTTPException(status_code=400, detail=f"Cannot retry job in {job.status} status")

    # Dead jobs exhausted all retries — reset the counter so the job gets a
    # full set of attempts rather than failing immediately on the first error.
    if job.status == "dead":
        job.retry_count = 0

    job.status       = "pending"
    job.error_msg    = None
    job.worker_id    = None
    job.started_at   = None
    job.completed_at = None
    db.commit()
    db.refresh(job)

    try:
        get_redis().lpush(queue_key(job.priority), str(job.id))
    except Exception:
        # Revert so the job stays visible and can be retried again.
        job.status = "failed"
        db.commit()
        raise HTTPException(status_code=503, detail="Queue unavailable — retry not scheduled")

    return job

# ----- Queue Stats -----

@router.get("/queue/stats")
def queue_stats(db: Session = Depends(get_db)):
    r = get_redis()

    workers_alive = sum(1 for _ in r.scan_iter("heartbeat:*"))

    counts = {
        status: count
        for status, count in db.query(Job.status, func.count(Job.id)).group_by(Job.status).all()
    }

    return {
        "queues": {name: r.llen(key) for name, key in PRIORITY_QUEUES.items()},
        "jobs": {
            "pending":    counts.get("pending", 0),
            "processing": counts.get("processing", 0),
            "completed":  counts.get("completed", 0),
            "failed":     counts.get("failed", 0),
            "dead":       counts.get("dead", 0),
        },
        "workers_alive": workers_alive,
    }

# ----- Workers -----

@router.get("/workers")
def get_workers(db: Session = Depends(get_db)):
    r = get_redis()

    worker_ids = []
    for key in r.scan_iter("heartbeat:*"):
        key_str = key.decode() if isinstance(key, bytes) else key
        parts = key_str.split(":", 1)
        if len(parts) == 2:
            worker_ids.append(parts[1])

    if not worker_ids:
        return {"workers": []}

    processing_jobs = {
        job.worker_id: job
        for job in db.query(Job)
        .filter(Job.status == "processing", Job.worker_id.in_(worker_ids))
        .all()
    }

    workers = []
    for worker_id in worker_ids:
        job = processing_jobs.get(worker_id)
        workers.append({
            "worker_id": worker_id,
            "current_job": {
                "id":       str(job.id),
                "job_type": job.job_type,
                "status":   job.status,
            } if job else None,
        })

    return {"workers": workers}
