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
    Redis             ← pushes job ID to priority queue
  (high/normal/low)
      │
      ▼
   Worker(s)          ← BLPOP, execute, update status
      │
      ▼
   Watchdog           ← requeues stuck jobs, marks dead
      │
      ▼
  Dashboard           ← React UI polling queue stats + SSE
```

---

## Technical Stack

| Component          | Technology              |
| :----------------- | :---------------------- |
| **Languages**      | Python, TypeScript, SQL |
| **Frontend**       | React, Tailwind CSS     |
| **Backend**        | FastAPI                 |
| **Broker/Cache**   | Redis                   |
| **Database**       | PostgreSQL              |
| **Infrastructure** | Docker, Linux           |

---

## Key Features

- **Priority Queues:** Three Redis lists (`high`, `normal`, `low`) mapped from a 1–10 priority field. Workers drain high before normal before low.
- **Idempotent Execution:** Workers check PostgreSQL before executing — already-completed jobs are skipped.
- **Automatic Retry + DLQ:** Watchdog detects stuck jobs via `started_at` timeout. Retries up to `max_retries`, then marks `dead`.
- **Heartbeat Tracking:** Each worker writes a TTL key to Redis every 10s — lets the API report live worker count.
- **Real-Time Dashboard:** React UI polls queue stats and opens SSE connections for per-job status streaming.
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

This starts PostgreSQL, Redis, the FastAPI API (port 8000), two worker replicas, the watchdog, and the React dashboard (port 3000).

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

| Method | Path                    | Description                             |
| :----- | :---------------------- | :-------------------------------------- |
| POST   | `/api/jobs`             | Enqueue a job — returns 202 with job ID |
| GET    | `/api/jobs/{id}`        | Get current job state from PostgreSQL   |
| GET    | `/api/queue/stats`      | Queue depths + job counts by status     |
| GET    | `/api/jobs/{id}/stream` | SSE stream of live status updates       |
| GET    | `/health`               | Health check                            |

### Job payload schema

```json
{
  "job_type": "string (max 64 chars)",
  "payload": { "...": "any JSON object" },
  "priority": 5,
  "max_retries": 3
}
```

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
                                       → dead
```

---

## Environment Variables

See [.env.example](.env.example) for all options.

| Variable                    | Default | Description                                   |
| :-------------------------- | :------ | :-------------------------------------------- |
| `DATABASE_URL`              | —       | PostgreSQL connection string                  |
| `REDIS_URL`                 | —       | Redis connection string                       |
| `WORKER_HEARTBEAT_INTERVAL` | `10`    | Seconds between heartbeat writes              |
| `WORKER_JOB_TIMEOUT`        | `300`   | Seconds before watchdog considers a job stuck |
| `WORKER_REPLICAS`           | `2`     | Default worker replica count                  |
| `WATCHDOG_POLL_INTERVAL`    | `30`    | Seconds between watchdog scans                |
| `MAX_RETRIES`               | `3`     | Max retry attempts before marking job as dead |

---

## Roadmap

| Phase | Description | Status |
| :---- | :---------- | :----- |
| 1 — Foundation | PostgreSQL + Redis + FastAPI services, Job model, Docker Compose | Done |
| 2 — Ingestion Layer | `POST /api/jobs`, `GET /api/jobs/{id}`, Pydantic validation, Redis enqueue | Done |
| 3 — Execution Layer | Worker BLPOP loop, idempotency check, status transitions, heartbeat | Next |
| 4 — Fault Tolerance | Watchdog process, stuck-job detection, auto-retry, dead-letter queue | Planned |
| 5 — Observability API | Queue stats endpoint, SSE live status streaming | Planned |
| 6 — Dashboard | React + TypeScript UI, live queue metrics, per-job SSE view | Planned |
| 7 — Testing | Unit tests, integration tests, horizontal scaling validation | Planned |
| 8 — Polish | Final README, single-command deploy, resume alignment | Planned |
