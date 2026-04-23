# NeoQueue

A distributed, fault-tolerant task queue engine with priority scheduling, automatic retry, and real-time observability.

---

## Architecture

```
POST /api/jobs
      │
      ▼
  PostgreSQL          ← persists job as "pending"
      │
      ▼
    Redis             ← pushes job ID to the priority queue
  (high/normal/low)
      │
      ▼
   Worker(s)          ← BLPOP, execute, update status
      │
      ▼
   Watchdog           ← requeues stuck jobs, marks dead
      │
      ▼
  Dashboard           ← React UI with live metrics, SSE streams, scenario runner
```

---

## Technical Stack

| Component          | Technology                      |
| :----------------- | :------------------------------ |
| **Languages**      | Python, TypeScript, SQL         |
| **Frontend**       | React, Vite, Tailwind CSS       |
| **Backend**        | FastAPI                         |
| **Broker/Cache**   | Redis                           |
| **Database**       | PostgreSQL                      |
| **Infrastructure** | Docker, Linux                   |

---

## Key Features

- **Priority Queues:** Three Redis lists (`high`, `normal`, `low`) mapped from a 1–10 priority field. Workers drain high before normal before low.
- **Idempotent Execution:** Workers check PostgreSQL before executing — already-completed jobs are skipped.
- **Automatic Retry + DLQ:** Watchdog detects stuck jobs via `started_at` timeout. Retries up to `max_retries`, then marks `dead`.
- **Manual Retry:** `POST /api/jobs/{id}/retry` re-enqueues any `failed` or `dead` job. Dead jobs get a full retry-count reset.
- **Heartbeat Tracking:** Each worker writes a TTL key to Redis every 10s — lets the API report live worker count.
- **Real-Time Dashboard:** React UI with live queue metrics, per-job SSE streams, job browser, live worker panel, DLQ inspection, and a built-in scenario runner.
- **Horizontal Scalability:** Workers scale with `--scale worker=N` via Docker Compose.

---

## Quick Start

### Prerequisites

Copy the example env file and adjust if needed:

```bash
cp .env.example .env
```

### Run the full stack

```bash
docker-compose up -d
```

This starts PostgreSQL, Redis, the FastAPI API (port 8000), four worker replicas, the watchdog, and the React dashboard (port 3000).

### Submit a job

```bash
curl -s -X POST http://localhost:8000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"job_type": "send_email", "payload": {"to": "user@example.com"}, "priority": 5, "max_retries": 3}' \
  | jq
```

### Check job status

```bash
curl http://localhost:8000/api/jobs/<job_id>
```

### Queue stats

```bash
curl http://localhost:8000/api/queue/stats
```

Returns Redis queue depths and PostgreSQL job counts by status.

---

## API Reference

| Method | Path                        | Description                                         |
| :----- | :-------------------------- | :-------------------------------------------------- |
| POST   | `/api/jobs`                 | Enqueue a job — returns 202 with job ID             |
| GET    | `/api/jobs`                 | List jobs filtered by status (up to 200)            |
| GET    | `/api/jobs/{id}`            | Get current job state from PostgreSQL               |
| POST   | `/api/jobs/{id}/retry`      | Re-enqueue a failed or dead job                     |
| GET    | `/api/jobs/{id}/stream`     | SSE stream of live status updates                   |
| GET    | `/api/queue/stats`          | Queue depths + job counts by status + workers alive |
| GET    | `/api/workers`              | Live worker list with current job per worker        |
| GET    | `/health`                   | Health check                                        |

### Job payload schema

```json
{
  "job_type": "string (max 64 chars)",
  "payload": { "...": "any JSON object" },
  "priority": 5,
  "max_retries": 3
}
```

### List jobs query params

| Param    | Default | Description                                           |
| :------- | :------ | :---------------------------------------------------- |
| `status` | —       | Filter by `pending`, `processing`, `completed`, `failed`, or `dead` |
| `limit`  | `50`    | Max records to return (1–200)                         |

### Priority mapping

| Priority | Queue              |
| :------- | :----------------- |
| 1–3      | `job_queue:high`   |
| 4–6      | `job_queue:normal` |
| 7–10     | `job_queue:low`    |

### Job status lifecycle

```
pending → processing → completed
                    ↘ failed → (retry) → pending
                                       → dead → (manual retry) → pending
```

---

## Supported Job Types

Workers have built-in handlers for the following job types. Any unknown type exhausts its retries and lands in the dead-letter queue.

| Job type              | Simulated work | Notes                                              |
| :-------------------- | :------------- | :------------------------------------------------- |
| `send_email`          | 1s             | Logs `to` and `subject` fields from payload        |
| `resize_image`        | 2s             | Logs `url`, `width`, `height`                      |
| `export_4k_video`     | 12s            | Logs `input`, `codec`, `bitrate_mbps`              |
| `train_ml_model`      | 8s             | Logs `model_name`, `dataset`, `epochs`             |
| `index_search_corpus` | 5s             | Logs `corpus_id`, `document_count`                 |
| `flaky_task`          | 4s (on success)| Fails `payload.fail_count` times, then completes   |

---

## Dashboard

Open [http://localhost:3000](http://localhost:3000) after starting the stack. The dashboard auto-refreshes every 5 seconds and exposes:

| Section          | Description                                                                 |
| :--------------- | :-------------------------------------------------------------------------- |
| **Hero metrics** | Workers alive, queue depth (high/normal/low), open live streams             |
| **Summary grid** | Queue pressure, processing count, completion rate, dead-letter rate         |
| **Active streams** | Per-job SSE traces; submit a job or click any row to open a stream        |
| **Job browser**  | Filter by status and limit, watch or retry individual jobs                  |
| **Live workers** | One card per alive worker showing current job or idle state                 |
| **Dead letter queue** | Last 20 dead jobs with error messages; click a row to open its stream |
| **Enqueue job**  | Manual form with presets for all supported job types                        |
| **Scenario runner** | Pre-built load scenarios (8–30 jobs) with progress tracking             |

### Load scenarios

| Scenario         | Jobs | Expected outcome                      |
| :--------------- | :--- | :------------------------------------ |
| Happy Path       | 10   | All complete                          |
| Flaky Once       | 8    | Each fails once, then completes       |
| Flaky Twice      | 8    | Each fails twice, then completes      |
| Flaky Intensive  | 16   | Flaky retries mixed with long jobs    |
| Priority Storm   | 10   | All high-priority, all complete       |
| DLQ Demo         | 12   | All go dead                           |
| Mixed Reality    | 20   | ~half complete, ~half dead            |
| Worker Stress    | 30   | All complete                          |
| Intensive        | 15   | Long-running jobs, all complete       |

---

## Environment Variables

See [.env.example](.env.example) for all options.

| Variable                    | Default | Description                                   |
| :-------------------------- | :------ | :-------------------------------------------- |
| `DATABASE_URL`              | —       | PostgreSQL connection string                  |
| `REDIS_URL`                 | —       | Redis connection string                       |
| `WORKER_HEARTBEAT_INTERVAL` | `10`    | Seconds between heartbeat writes              |
| `WORKER_JOB_TIMEOUT`        | `300`   | Seconds before watchdog considers a job stuck |
| `WORKER_REPLICAS`           | `4`     | Default worker replica count                  |
| `WATCHDOG_POLL_INTERVAL`    | `30`    | Seconds between watchdog scans                |
| `MAX_RETRIES`               | `3`     | Max retry attempts before marking job as dead |

---

## End-to-End Test Guide

A structured five-phase test that exercises the full stack from container startup through fault recovery and live streaming.

### Phase 1 — Stack Verification

```bash
# Build images and start all services in the background
docker compose up --build -d

# Confirm the 'jobs' table was created by SQLAlchemy on startup
docker exec -it neoqueue_postgres psql -U neoqueue -d neoqueue -c "\dt"

# Inspect all expected columns (id, status, priority, worker_id, etc.)
docker exec -it neoqueue_postgres psql -U neoqueue -d neoqueue -c "\d jobs"

# Confirm FastAPI is reachable and healthy
curl http://localhost:8000/health
```

`\dt` lists all tables in the current database. `\d jobs` describes the column definitions, types, indexes, and constraints on the `jobs` table. The health endpoint returns `{"status": "ok"}` when the app has started and connected to the database.

---

### Phase 2 — Job Ingestion

```bash
# Submit a high-priority email job (priority 1 routes to job_queue:high)
curl -X POST http://localhost:8000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"job_type": "send_email", "payload": {"to": "test@example.com", "subject": "Hello"}, "priority": 1, "max_retries": 3}'

# Confirm the job row exists in PostgreSQL — note the returned 'id'
docker exec -it neoqueue_postgres psql -U neoqueue -d neoqueue \
  -c "SELECT id, status, priority FROM jobs WHERE id = '<job_id>';"

# Confirm the job ID was pushed to the Redis high-priority list
# LRANGE returns all elements from index 0 to -1 (the full list)
docker exec -it neoqueue_redis redis-cli LRANGE job_queue:high 0 -1

# Fetch the job over the API to confirm the response schema
curl http://localhost:8000/api/jobs/<job_id>
```

The API persists the job to PostgreSQL first (so it has an ID), then pushes the ID onto the appropriate Redis list. Workers pop from the right side; the API pushes to the left (`LPUSH`), so the list is FIFO within a priority tier.

---

### Phase 3 — Worker Execution

```bash
# Scale up to 3 concurrent workers and stream their combined logs
docker compose up --scale worker=3 -d
docker compose logs -f worker

# Submit a job and watch it transition through states
curl -X POST http://localhost:8000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"job_type": "send_email", "payload": {"to": "test@example.com", "subject": "Hello"}, "priority": 1, "max_retries": 3}'

# Poll PostgreSQL to see pending → processing → completed
docker exec -it neoqueue_postgres psql -U neoqueue -d neoqueue \
  -c "SELECT id, status, started_at, completed_at, worker_id FROM jobs ORDER BY created_at DESC LIMIT 5;"

# Confirm each running worker has written a TTL heartbeat key to Redis
docker exec -it neoqueue_redis redis-cli KEYS "heartbeat:*"
```

Each worker runs a background thread that writes `heartbeat:<worker-id>` to Redis every 10 seconds with a 30-second TTL. If a worker dies, its key expires naturally. `KEYS "heartbeat:*"` returns one key per live worker — the same count exposed by `/api/queue/stats` under `workers_alive`.

---

### Phase 4 — Fault Recovery

```bash
# Submit a long-running job (resize_image simulates 2s of work)
curl -X POST http://localhost:8000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"job_type": "resize_image", "payload": {"url": "http://example.com/img.jpg", "width": 800, "height": 600}, "priority": 2, "max_retries": 3}'

# Find which worker picked it up
docker exec -it neoqueue_postgres psql -U neoqueue -d neoqueue \
  -c "SELECT id, status, worker_id, started_at FROM jobs ORDER BY created_at DESC LIMIT 1;"

# Kill all workers to simulate a crash mid-execution
docker compose kill worker

# Watch the watchdog detect the stuck job
docker compose logs -f watchdog

# Confirm the job was requeued (status='pending', retry_count=1) or marked dead
docker exec -it neoqueue_postgres psql -U neoqueue -d neoqueue \
  -c "SELECT id, status, retry_count, error_msg FROM jobs ORDER BY created_at DESC LIMIT 1;"
```

The watchdog scans PostgreSQL every `WATCHDOG_POLL_INTERVAL` seconds for jobs stuck in `processing` longer than `WORKER_JOB_TIMEOUT` seconds. Before requeueing, it checks whether the assigned worker's heartbeat key still exists in Redis. If the key is gone, the job is requeued to `job_queue:normal` with `retry_count + 1`. Once `retry_count` exceeds `max_retries`, the job is marked `dead`. To make this test run faster, override the defaults:

```bash
WATCHDOG_POLL_INTERVAL=15 WORKER_JOB_TIMEOUT=20 docker compose up -d watchdog
```

---

### Phase 5 — Observability

```bash
# Get a snapshot of queue depths and job counts by status
curl http://localhost:8000/api/queue/stats
```

Returns:

```json
{
  "queues": { "high": 0, "normal": 0, "low": 0 },
  "jobs": {
    "pending": 0,
    "processing": 0,
    "completed": 4,
    "failed": 0,
    "dead": 0
  },
  "workers_alive": 4
}
```

```bash
# Submit a job, then open an SSE stream on it in a second terminal
curl -X POST http://localhost:8000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"job_type": "send_email", "payload": {"to": "test@example.com", "subject": "Hello"}, "priority": 1, "max_retries": 3}'

# -N disables output buffering so events arrive immediately as they are emitted
curl -N http://localhost:8000/api/jobs/<job_id>/stream
```

The stream emits a `data:` line each time the job's status changes:

```
data: {"job_id": "...", "status": "processing", "started_at": "...", ...}

data: {"job_id": "...", "status": "completed", "completed_at": "...", ...}
```

The connection closes automatically when the job reaches a terminal state (`completed`, `failed`, or `dead`). The server polls PostgreSQL every second and only emits an event when the status actually changes, so the stream is quiet when nothing has changed.

---

## Roadmap

| Phase                 | Description                                                                | Status |
| :-------------------- | :------------------------------------------------------------------------- | :----- |
| 1 — Foundation        | PostgreSQL + Redis + FastAPI services, Job model, Docker Compose           | Done   |
| 2 — Ingestion Layer   | `POST /api/jobs`, `GET /api/jobs/{id}`, Pydantic validation, Redis enqueue | Done   |
| 3 — Execution Layer   | Worker BLPOP loop, idempotency check, status transitions, heartbeat        | Done   |
| 4 — Fault Tolerance   | Watchdog process, stuck-job detection, auto-retry, dead-letter queue       | Done   |
| 5 — Observability API | Queue stats endpoint, SSE live status streaming, list + retry endpoints    | Done   |
| 6 — Dashboard         | React + Vite UI, live metrics, job browser, worker panel, scenario runner  | Done   |
