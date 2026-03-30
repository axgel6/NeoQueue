import os
from typing import Optional

import redis

# Singleton Redis client instance
_client: Optional[redis.Redis] = None

# Returns a shared Redis client, creating it on first call
def get_redis() -> redis.Redis:
    global _client
    if _client is None:
        redis_url = os.getenv("REDIS_URL")
        if not redis_url:
            raise ValueError("REDIS_URL environment variable is not set")
        _client = redis.Redis.from_url(redis_url)
    return _client

# Canonical queue names; used by both the API and worker
PRIORITY_QUEUES = {
    "high":   "job_queue:high",
    "normal": "job_queue:normal",
    "low":    "job_queue:low",
}

# Maps a numeric priority (1-10) to a Redis queue key
# 1–3 -> high, 4–6 -> normal, 7–10 -> low
def queue_key(priority: int) -> str:
    if priority <= 3:
        return PRIORITY_QUEUES["high"]
    if priority <= 6:
        return PRIORITY_QUEUES["normal"]
    return PRIORITY_QUEUES["low"]