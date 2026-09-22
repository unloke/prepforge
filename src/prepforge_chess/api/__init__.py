"""Production SaaS API (FastAPI).

This package serves identity, billing, teams, and the domain API.

Local dev and the test suite run on SQLite; production runs on PostgreSQL by
setting ``DATABASE_URL``. Engines run in the browser, so this service never
performs chess computation -- it stores data, enforces ownership, and bills.
"""
