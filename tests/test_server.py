"""End-to-end coverage for the FastAPI surface (dashboard + JSON APIs)."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from robomp.config import Settings
from robomp.dashboard import tail_jsonl
from robomp.db import close_database, get_database, issue_key
from robomp.server import create_app


def _seed_db(settings: Settings) -> None:
    db = get_database(settings.sqlite_path)
    db.record_event(
        delivery_id="d-queued",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 1),
        payload={"action": "opened", "issue": {"number": 1}},
    )
    db.record_event(
        delivery_id="d-skipped",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 2),
        payload={"action": "labeled"},
        state="skipped",
    )
    # Promote one event to "running" so the running_events list isn't empty.
    db.record_event(
        delivery_id="d-running",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 3),
        payload={"action": "created"},
    )
    claimed = db.claim_next_event()
    assert claimed is not None  # d-queued or d-running depending on order
    # Make sure at least one event is in running state for our assertions.
    db.upsert_issue(
        key=issue_key("octo/widget", 3),
        repo="octo/widget",
        number=3,
        state="opened",
        branch="farm/abc12345/fix",
        pr_number=42,
    )
    db.set_issue_classification(issue_key("octo/widget", 3), "bug")


def test_index_serves_dashboard_html(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    # A few load-bearing markers from the page; if these vanish, the dashboard
    # changed shape and the rest of the test suite should be updated too.
    assert "<title>robomp</title>" in resp.text
    assert "api/status" in resp.text
    assert "api/logs" in resp.text


def test_api_status_reports_runtime_counts_and_inflight(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        _seed_db(settings)
        resp = client.get("/api/status")
    close_database()

    assert resp.status_code == 200
    body = resp.json()

    runtime = body["runtime"]
    assert runtime["bot_login"] == "robomp-bot"
    assert runtime["repo_allowlist"] == ["octo/widget"]
    assert runtime["max_concurrency"] == settings.max_concurrency
    assert runtime["model"] == settings.model
    assert runtime["uptime_seconds"] >= 0

    counts = body["event_counts"]
    # All five buckets must be present even when zero — the UI relies on it.
    assert set(counts) == {"queued", "running", "done", "failed", "skipped"}
    assert counts["queued"] + counts["running"] == 2  # d-queued + d-running
    assert counts["skipped"] == 1
    assert counts["running"] >= 1

    running = body["running_events"]
    assert running, "expected at least one running event after claim"
    assert all(r["started_at"] for r in running)

    # No worker pool was started in TestClient lifespan? It actually is — verify
    # the inflight snapshot returns a list even when empty.
    assert isinstance(body["inflight"], list)

    issues = {i["key"]: i for i in body["issues"]}
    fix_key = issue_key("octo/widget", 3)
    assert fix_key in issues
    assert issues[fix_key]["classification"] == "bug"
    assert issues[fix_key]["pr_number"] == 42
    assert issues[fix_key]["branch"] == "farm/abc12345/fix"

    delivery_ids = {e["delivery_id"] for e in body["recent_events"]}
    assert {"d-queued", "d-skipped", "d-running"}.issubset(delivery_ids)


def test_api_logs_returns_empty_when_file_missing(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/logs?limit=10")
    close_database()
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"entries": [], "count": 0, "limit": 10}


def test_api_logs_tails_jsonl_file(settings: Settings) -> None:
    log_path = settings.log_dir / "robomp.log.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    payloads = [
        {"ts": "2026-05-14T21:28:28Z", "level": "INFO", "logger": "robomp.queue", "msg": "dispatch loop online"},
        {"ts": "2026-05-14T21:28:54Z", "level": "INFO", "logger": "robomp.server", "msg": "skip",
         "event": "issues", "reason": "issues.labeled ignored"},
        {"ts": "2026-05-14T21:30:00Z", "level": "WARNING", "logger": "robomp.queue", "msg": "tool_end",
         "ok": False},
    ]
    log_path.write_text("\n".join(json.dumps(p) for p in payloads) + "\n", encoding="utf-8")

    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/logs?limit=2")
    close_database()

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert body["limit"] == 2
    # Oldest of the requested window first.
    assert body["entries"][0]["msg"] == "skip"
    assert body["entries"][1]["msg"] == "tool_end"
    assert body["entries"][1]["level"] == "WARNING"


def test_api_logs_limit_is_clamped(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        too_low = client.get("/api/logs?limit=0").json()
        too_high = client.get("/api/logs?limit=99999").json()
    close_database()
    assert too_low["limit"] == 1
    assert too_high["limit"] == 2000


def test_tail_jsonl_recovers_from_garbage_lines(tmp_path: Path) -> None:
    path = tmp_path / "noisy.jsonl"
    path.write_text(
        json.dumps({"ts": "a", "level": "INFO", "msg": "ok"}) + "\n"
        "{not json}\n"
        + json.dumps({"ts": "b", "level": "ERROR", "msg": "bang"}) + "\n",
        encoding="utf-8",
    )
    rows = tail_jsonl(path, limit=10)
    assert len(rows) == 3
    assert rows[0]["msg"] == "ok"
    assert rows[1]["level"] == "RAW"
    assert rows[1]["msg"] == "{not json}"
    assert rows[2]["level"] == "ERROR"
