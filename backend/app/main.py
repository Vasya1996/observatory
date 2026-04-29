"""FastAPI entry point — wires the index cache, watcher, and routers."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .api import router
from .watcher import IndexCache, start_watcher

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("observatory")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cache = IndexCache()
    cache.attach_loop(asyncio.get_running_loop())
    app.state.index_cache = cache
    observer = start_watcher(cache)
    log.info("scanned %d files, %d edges (initial)",
             len(cache.snapshot()[0]), len(cache.snapshot()[1]))
    try:
        yield
    finally:
        observer.stop()
        observer.join(timeout=2)


app = FastAPI(title="Observatory", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.FRONTEND_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router, prefix="/api")


@app.get("/")
def root() -> dict:
    return {
        "name": "observatory",
        "endpoints": [
            "/api/index", "/api/cwds", "/api/simulate?cwd=...",
            "/api/file?path=...", "/api/extensions",
            "/api/state", "/api/events",
            "/api/paths-proposals",
        ],
    }
