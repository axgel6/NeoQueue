from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Job
from app.schemas import JobCreate, JobResponse
from app.redis_client import get_redis, queue_key

router = APIRouter()


# POST /jobs: creates a new job record and push its ID onto the appropriate Redis priority queue
@router.post("/jobs", response_model=JobResponse, status_code=202)
def enqueue_job(body: JobCreate, db: Session = Depends(get_db)):
    # Persists the job to the database first so it has an ID before queuing
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


# GET /jobs/{job_id}: fetch a single job by its UUID
@router.get("/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# GET /queue/stats: returns live queue lengths from Redis and job status counts from the database
@router.get("/queue/stats")
def queue_stats(db: Session = Depends(get_db)):
    r = get_redis()
    return {
        # Number of job IDs currently waiting in each Redis priority queue
        "queues": {
            "high":   r.llen("job_queue:high"),
            "normal": r.llen("job_queue:normal"),
            "low":    r.llen("job_queue:low"),
        },
        # Counts of jobs grouped by their current status in the database
        "jobs": {
            "pending":    db.query(Job).filter_by(status="pending").count(),
            "processing": db.query(Job).filter_by(status="processing").count(),
            "completed":  db.query(Job).filter_by(status="completed").count(),
            "failed":     db.query(Job).filter_by(status="failed").count(),
            "dead":       db.query(Job).filter_by(status="dead").count(),
        }
    }