"""FastAPI receiver for GitHub webhooks."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse

from robomp import github_events
from robomp.config import Settings, get_settings
from robomp.db import Database, get_database, issue_key as make_issue_key
from robomp.github_client import GitHubClient
from robomp.queue import WorkerPool
from robomp.sandbox import SandboxManager
from robomp.dashboard import INDEX_HTML, tail_jsonl

log = logging.getLogger(__name__)


def _build_state(settings: Settings) -> dict[str, Any]:
    db = get_database(settings.sqlite_path)
    github = GitHubClient(settings.github_token.get_secret_value())
    sandbox = SandboxManager(settings.workspace_root)
    pool = WorkerPool(settings=settings, db=db, github=github, sandbox=sandbox)
    return {"settings": settings, "db": db, "github": github, "sandbox": sandbox, "pool": pool}


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI app. `settings` parameter is for tests."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cfg = settings or get_settings()
        cfg.ensure_paths()
        app.state.bag = _build_state(cfg)
        app.state.bag["started_at"] = time.time()
        pool: WorkerPool = app.state.bag["pool"]
        await pool.start()
        try:
            yield
        finally:
            await pool.stop()

    app = FastAPI(title="robomp", version="0.1.0", lifespan=lifespan)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz(request: Request) -> dict[str, str]:
        pool = request.app.state.bag.get("pool")
        if pool is None:
            raise HTTPException(503, "not initialized")
        return {"status": "ready"}

    @app.post("/webhook/github")
    async def webhook(
        request: Request,
        x_github_event: str = Header(..., alias="X-GitHub-Event"),
        x_github_delivery: str = Header(..., alias="X-GitHub-Delivery"),
        x_hub_signature_256: str | None = Header(None, alias="X-Hub-Signature-256"),
    ) -> JSONResponse:
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        body = await request.body()
        if not github_events.verify_signature(
            cfg.github_webhook_secret.get_secret_value(),
            body,
            x_hub_signature_256,
        ):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid signature")
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid json: {exc}")

        db: Database = bag["db"]

        def _resolve(repo_full: str, pr_number: int) -> str | None:
            row = db.find_issue_by_pr(repo_full, pr_number)
            return row.key if row else None

        decision = github_events.route(
            x_github_event,
            payload,
            allowlist=cfg.repo_allowlist,
            bot_login=cfg.bot_login,
            resolve_issue_from_pr=_resolve,
        )

        if not decision.should_queue:
            log.info("skip", extra={"event": x_github_event, "reason": decision.reason})
            db.record_event(
                delivery_id=x_github_delivery,
                event_type=x_github_event,
                repo=decision.repo,
                issue_key=decision.issue_key,
                payload=payload,
                state="skipped",
            )
            return JSONResponse({"delivery": x_github_delivery, "state": "skipped"}, status_code=202)

        inserted = db.record_event(
            delivery_id=x_github_delivery,
            event_type=x_github_event,
            repo=decision.repo,
            issue_key=decision.issue_key,
            payload=payload,
            state="queued",
        )
        if inserted:
            pool: WorkerPool = bag["pool"]
            pool.wake()
            log.info("queued", extra={"event": x_github_event, "delivery": x_github_delivery, "key": decision.issue_key})
        else:
            log.info("duplicate", extra={"event": x_github_event, "delivery": x_github_delivery})
        return JSONResponse({"delivery": x_github_delivery, "state": "queued"}, status_code=202)

    @app.post("/replay")
    async def replay(
        request: Request,
        x_robomp_token: str | None = Header(None, alias="X-Robomp-Replay-Token"),
        delivery_id: str = "",
    ) -> JSONResponse:
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        if cfg.replay_token is None:
            raise HTTPException(404, "replay disabled")
        if x_robomp_token != cfg.replay_token.get_secret_value():
            raise HTTPException(401, "invalid replay token")
        db: Database = bag["db"]
        row = db.get_event(delivery_id)
        if row is None:
            raise HTTPException(404, "unknown delivery")
        db.requeue_event(delivery_id)
        bag["pool"].wake()
        return JSONResponse({"delivery": delivery_id, "state": "queued"})

    @app.get("/events")
    async def events(request: Request, limit: int = 50) -> dict[str, Any]:
        rows = request.app.state.bag["db"].list_events(limit=limit)
        return {
            "events": [
                {
                    "delivery_id": r.delivery_id,
                    "event_type": r.event_type,
                    "repo": r.repo,
                    "issue_key": r.issue_key,
                    "state": r.state,
                    "attempts": r.attempts,
                    "received_at": r.received_at,
                    "last_error": r.last_error,
                }
                for r in rows
            ]
        }

    @app.get("/issues")
    async def issues(request: Request, limit: int = 100) -> dict[str, Any]:
        rows = request.app.state.bag["db"].list_issues(limit=limit)
        return {
            "issues": [
                {
                    "key": r.key,
                    "repo": r.repo,
                    "number": r.number,
                    "branch": r.branch,
                    "pr_number": r.pr_number,
                    "state": r.state,
                    "classification": r.classification,
                    "updated_at": r.updated_at,
                }
                for r in rows
            ]
        }


    @app.get("/", response_class=HTMLResponse)
    async def index() -> HTMLResponse:
        return HTMLResponse(INDEX_HTML)

    @app.get("/api/status")
    async def api_status(request: Request) -> dict[str, Any]:
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        db: Database = bag["db"]
        pool: WorkerPool = bag["pool"]
        started = float(bag.get("started_at") or time.time())
        issues_rows = db.list_issues(limit=200)
        events_rows = db.list_events(limit=25)
        return {
            "runtime": {
                "bot_login": cfg.bot_login,
                "repo_allowlist": sorted(cfg.repo_allowlist),
                "max_concurrency": cfg.max_concurrency,
                "model": cfg.model,
                "thinking_level": cfg.thinking_level,
                "uptime_seconds": max(0.0, time.time() - started),
            },
            "event_counts": db.event_state_counts(),
            "running_events": db.list_running_events(),
            "inflight": await pool.inflight_snapshot(),
            "issues": [
                {
                    "key": r.key,
                    "repo": r.repo,
                    "number": r.number,
                    "branch": r.branch,
                    "pr_number": r.pr_number,
                    "state": r.state,
                    "classification": r.classification,
                    "updated_at": r.updated_at,
                }
                for r in issues_rows
            ],
            "recent_events": [
                {
                    "delivery_id": r.delivery_id,
                    "event_type": r.event_type,
                    "repo": r.repo,
                    "issue_key": r.issue_key,
                    "state": r.state,
                    "attempts": r.attempts,
                    "received_at": r.received_at,
                    "last_error": r.last_error,
                }
                for r in events_rows
            ],
        }

    @app.get("/api/logs")
    async def api_logs(request: Request, limit: int = 400) -> dict[str, Any]:
        cfg: Settings = request.app.state.bag["settings"]
        capped = max(1, min(int(limit), 2000))
        entries = tail_jsonl(cfg.log_dir / "robomp.log.jsonl", limit=capped)
        return {"entries": entries, "count": len(entries), "limit": capped}

    return app


__all__ = ["create_app"]
