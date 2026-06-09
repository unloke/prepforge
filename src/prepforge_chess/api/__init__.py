"""Production SaaS API (FastAPI).

This package is the multi-tenant web service that will eventually replace the
single-file stdlib server in ``prepforge_chess.web.server``. It is introduced
alongside the legacy server (strangler pattern): identity, billing, and the
team/classroom data model live here from the start, and the legacy ``/api/*``
endpoints are ported over incrementally.

Local dev and the test suite run on SQLite; production runs on PostgreSQL by
setting ``DATABASE_URL``. Engines run in the browser, so this service never
performs chess computation -- it stores data, enforces ownership, and bills.
"""
