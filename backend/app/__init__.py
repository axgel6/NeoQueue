from fastapi import FastAPI
from app.database import engine, Base
from app.routes import router

# App factory: creates tables and registers routes
def create_app() -> FastAPI:
    app = FastAPI(title="NeoQueue")

    # Create tables on startup (swap for Alembic in prod)
    Base.metadata.create_all(bind=engine)

    app.include_router(router, prefix="/api")
    app.add_api_route("/health", _health)
    return app


def _health():
    return {"status": "ok"}
