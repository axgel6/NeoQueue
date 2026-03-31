import os
import time
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Job
from app.redis_client import get_redis, PRIORITY_QUEUES

# ----- Config -----

DATABASE_URL     = os.getenv("DATABASE_URL", "")
HEARTBEAT_PREFIX = "heartbeat:"
POLL_INTERVAL    = int(os.getenv("WATCHDOG_POLL_INTERVAL", 60)) # Seconds between watchdog scans (1 minute)
JOB_TIMEOUT      = int(os.getenv("WORKER_JOB_TIMEOUT", 300))    # Seconds before a "processing" job is considered stuck (5 minutes)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ----- DB Setup -----

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)

# ----- Failure Handler -----

def handle_failure(session, job: Job, error_msg: str):
    job.retry_count += 1
    job.error_msg    = error_msg

    if job.retry_count <= job.max_retries:
        job.status = "pending"
        session.commit()
        get_redis().rpush(PRIORITY_QUEUES["normal"], str(job.id))
        log.warning(
            f"[watchdog] Job {job.id} re-queued "
            f"(attempt {job.retry_count}/{job.max_retries}). Reason: {error_msg}"
        )
    else:
        job.status = "dead"
        session.commit()
        log.error(f"[watchdog] Job {job.id} marked dead — exhausted retries. Reason: {error_msg}")

# ----- Watchdog Loop -----

def run_watchdog():
    log.info("[watchdog] Starting.")

    while True:
        time.sleep(POLL_INTERVAL)

        session = SessionLocal()
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(seconds=JOB_TIMEOUT)

            stuck_jobs = (
                session.query(Job)
                .filter(Job.status == "processing")
                .filter(Job.started_at < cutoff)
                .all()
            )

            if not stuck_jobs:
                log.debug("[watchdog] No stuck jobs found.")
                continue

            log.info(f"[watchdog] Found {len(stuck_jobs)} stuck job(s).")

            for job in stuck_jobs:
                heartbeat_key = f"{HEARTBEAT_PREFIX}{job.worker_id}"
                worker_alive  = get_redis().exists(heartbeat_key)

                if worker_alive:
                    log.info(f"[watchdog] Job {job.id} is slow but worker {job.worker_id} is alive — skipping.")
                    continue

                log.warning(
                    f"[watchdog] Job {job.id} stuck — "
                    f"worker {job.worker_id} heartbeat missing. Recovering."
                )
                handle_failure(session, job, error_msg="Worker timeout — heartbeat lost")

        except Exception as e:
            log.exception(f"[watchdog] Unexpected error during scan: {e}")
        finally:
            session.close()


if __name__ == "__main__":
    run_watchdog()