import os
import uuid
import time
from typing import Optional, cast
from uuid import UUID
import logging
import threading

import redis
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Job

# ----- Config -----

REDIS_URL        = os.getenv("REDIS_URL", "redis://localhost:6379")
DATABASE_URL     = os.environ["DATABASE_URL"]
JOB_QUEUE_KEY    = "queue:jobs"
HEARTBEAT_PREFIX = "heartbeat:"
HEARTBEAT_TTL    = 30       # seconds before key expires
HEARTBEAT_INTERVAL = 10     # seconds between writes
MAX_BLOCK_TIMEOUT  = 5      # BLPOP timeout in seconds

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ----- DB + Redis -----

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)

r = redis.from_url(REDIS_URL, decode_responses=True)

# ----- Job Handlers -----

def handle_send_email(payload: dict):
    log.info(f"[send_email] Sending to {payload.get('to')} — subject: {payload.get('subject')}")
    time.sleep(1)  # simulate work

def handle_resize_image(payload: dict):
    log.info(f"[resize_image] Resizing {payload.get('image_url')} to {payload.get('width')}x{payload.get('height')}")
    time.sleep(2)  # simulate work

JOB_HANDLERS = {
    "send_email":   handle_send_email,
    "resize_image": handle_resize_image,
}

# ----- Core Logic -----

def execute_job(job: Job):
    handler = JOB_HANDLERS.get(job.job_type)
    if not handler:
        raise ValueError(f"Unknown job_type: '{job.job_type}'")
    handler(job.payload)


def mark_processing(session, job: Job, worker_id: str):
    from datetime import datetime, timezone
    job.status     = "processing"
    job.started_at = datetime.now(timezone.utc)
    job.worker_id  = worker_id
    session.commit()


def mark_completed(session, job: Job):
    from datetime import datetime, timezone
    job.status       = "completed"
    job.completed_at = datetime.now(timezone.utc)
    session.commit()
    log.info(f"[worker] Job {job.id} completed.")


def handle_failure(session, job: Job, error: Exception):
    job.retry_count = job.retry_count + 1
    job.error_msg    = str(error)

    if job.retry_count <= job.max_retries:
        job.status = "pending"
        session.commit()
        r.rpush(JOB_QUEUE_KEY, str(job.id))
        log.warning(f"[worker] Job {job.id} failed (attempt {job.retry_count}/{job.max_retries}), re-queued. Error: {error}")
    else:
        job.status = "dead"
        session.commit()
        log.error(f"[worker] Job {job.id} exhausted retries — marked dead. Error: {error}")

# ----- Heartbeat -----


def heartbeat_loop(worker_id: str):
    key = f"{HEARTBEAT_PREFIX}{worker_id}"
    while True:
        try:
            r.set(key, "alive", ex=HEARTBEAT_TTL)
            log.debug(f"[heartbeat] {worker_id} — alive")
        except Exception as e:
            log.warning(f"[heartbeat] Redis write failed: {e}")
        time.sleep(HEARTBEAT_INTERVAL)

# ----- Main Worker Loop -----

def run_worker():
    worker_id = str(uuid.uuid4())
    log.info(f"[worker] Starting — ID: {worker_id}")

    # Start heartbeat in background thread
    hb_thread = threading.Thread(target=heartbeat_loop, args=(worker_id,), daemon=True)
    hb_thread.start()

    while True:
        try:
            # Blocking pop — waits up to MAX_BLOCK_TIMEOUT seconds
            result = cast(Optional[tuple[str, str]], r.blpop([JOB_QUEUE_KEY], timeout=MAX_BLOCK_TIMEOUT))

            if result is None:
                continue  # timeout, loop again

            _, job_id = result  # blpop returns (key, value)

            session = SessionLocal()
            try:
                job = session.get(Job, UUID(job_id))

                if job is None:
                    log.warning(f"[worker] Job {job_id} not found in DB — skipping.")
                    continue

                if job.status != "pending":
                    log.info(f"[worker] Job {job_id} is '{job.status}' — skipping.")
                    continue

                mark_processing(session, job, worker_id)

                try:
                    execute_job(job)
                    mark_completed(session, job)
                except Exception as e:
                    handle_failure(session, job, e)

            finally:
                session.close()

        except redis.RedisError as e:
            log.error(f"[worker] Redis error: {e} — retrying in 3s")
            time.sleep(3)
        except Exception as e:
            log.exception(f"[worker] Unexpected error: {e}")
            time.sleep(1)


if __name__ == "__main__":
    run_worker()