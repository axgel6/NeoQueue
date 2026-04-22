import os
import uuid
import time
import logging
import threading
from datetime import datetime, timezone

import redis
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Job
from app.redis_client import get_redis, queue_key, PRIORITY_QUEUES

# ----- Config -----

DATABASE_URL       = os.getenv("DATABASE_URL", "")
HEARTBEAT_PREFIX   = "heartbeat:"
HEARTBEAT_TTL      = 30
HEARTBEAT_INTERVAL = int(os.getenv("WORKER_HEARTBEAT_INTERVAL", 10))
MAX_BLOCK_TIMEOUT  = 5

QUEUE_KEYS = [
    PRIORITY_QUEUES["high"],
    PRIORITY_QUEUES["normal"],
    PRIORITY_QUEUES["low"],
]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ----- DB Setup -----

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)

# ----- Job Handlers -----

def handle_send_email(job: Job):
    payload = job.payload
    log.info(f"[send_email] Sending to {payload.get('to')} — subject: {payload.get('subject')}")
    time.sleep(1)

def handle_resize_image(job: Job):
    payload = job.payload
    log.info(f"[resize_image] Resizing {payload.get('url')} to {payload.get('width')}x{payload.get('height')}")
    time.sleep(2)

def handle_export_4k_video(job: Job):
    payload = job.payload
    log.info(f"[export_4k_video] Encoding {payload.get('input')} → {payload.get('codec')} 4K @ {payload.get('bitrate_mbps')} Mbps")
    time.sleep(12)

def handle_train_ml_model(job: Job):
    payload = job.payload
    log.info(f"[train_ml_model] Training {payload.get('model_name')} on {payload.get('dataset')} for {payload.get('epochs')} epochs")
    time.sleep(8)

def handle_index_search_corpus(job: Job):
    payload = job.payload
    log.info(f"[index_search_corpus] Indexing corpus '{payload.get('corpus_id')}' — {payload.get('document_count')} docs")
    time.sleep(5)

def handle_flaky_task(job: Job):
    fail_count = int(job.payload.get("fail_count", 1))
    log.info(
        f"[flaky_task] Job {job.id} attempt {job.retry_count + 1} — "
        f"failing first {fail_count} attempt(s) before success"
    )
    if job.retry_count < fail_count:
        raise RuntimeError(
            f"Transient failure {job.retry_count + 1}/{fail_count}: simulated retry"
        )
    time.sleep(4)

JOB_HANDLERS = {
    "send_email":          handle_send_email,
    "resize_image":        handle_resize_image,
    "export_4k_video":     handle_export_4k_video,
    "train_ml_model":      handle_train_ml_model,
    "index_search_corpus": handle_index_search_corpus,
    "flaky_task":          handle_flaky_task,
}

# ----- Core Logic -----

def execute_job(job: Job):
    handler = JOB_HANDLERS.get(job.job_type)
    if not handler:
        raise ValueError(f"Unknown job_type: '{job.job_type}'")
    handler(job)


def mark_processing(session, job: Job, worker_id: str):
    job.status       = "processing"
    job.started_at   = datetime.now(timezone.utc)
    job.worker_id    = worker_id
    job.error_msg    = None
    job.completed_at = None
    session.commit()


def mark_completed(session, job: Job):
    job.status       = "completed"
    job.completed_at = datetime.now(timezone.utc)
    session.commit()
    log.info(f"[worker] Job {job.id} completed.")


def handle_failure(session, job: Job, error: Exception):
    job.retry_count += 1
    job.error_msg    = str(error)
    job.worker_id    = None

    if job.retry_count < job.max_retries:
        job.status = "failed"
        session.commit()
        try:
            get_redis().rpush(queue_key(job.priority), str(job.id))
            log.warning(f"[worker] Job {job.id} failed (attempt {job.retry_count}/{job.max_retries}), re-queued. Error: {error}")
        except Exception as re:
            log.error(f"[worker] Job {job.id} failed but re-queue failed: {re} — watchdog will recover it")
    else:
        job.status       = "dead"
        job.completed_at = datetime.now(timezone.utc)
        session.commit()
        log.error(f"[worker] Job {job.id} exhausted retries — marked dead. Error: {error}")

# ----- Heartbeat -----

def heartbeat_loop(worker_id: str):
    key = f"{HEARTBEAT_PREFIX}{worker_id}"
    r   = get_redis()
    while True:
        try:
            r.set(key, "alive", ex=HEARTBEAT_TTL)
            log.debug(f"[heartbeat] {worker_id} — alive")
        except Exception as e:
            log.warning(f"[heartbeat] Redis write failed: {e}")
        time.sleep(HEARTBEAT_INTERVAL)

# ----- Worker Loop -----

def run_worker():
    worker_id = str(uuid.uuid4())
    log.info(f"[worker] Starting — ID: {worker_id}")

    hb_thread = threading.Thread(target=heartbeat_loop, args=(worker_id,), daemon=True)
    hb_thread.start()

    r = get_redis()

    while True:
        try:
            result = r.blpop(QUEUE_KEYS, timeout=MAX_BLOCK_TIMEOUT)

            if result is None:
                continue

            _, job_id = result  # type: ignore[misc]
            job_id = job_id.decode() if isinstance(job_id, bytes) else job_id

            session = SessionLocal()
            try:
                job = session.query(Job).filter(Job.id == job_id).first()

                if job is None:
                    log.warning(f"[worker] Job {job_id} not found in DB — skipping.")
                    continue

                if job.status not in ("pending", "failed"):
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
