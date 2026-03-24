import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Load DB URL from env, fail fast if missing
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is not set")

# Create engine with health checks and 30s query timeout
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args={"options": "-c statement_timeout=30000"}
    )

# Session factory: no autocommit/autoflush; Base for model definitions
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# FastAPI dependency: yields a DB session, always closes on exit
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
