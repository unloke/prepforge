# Deploy PrepForge Chess

PrepForge Chess is not a GitHub Pages-only app. GitHub Pages can host static
HTML/CSS/JS, but this project needs a Python web server, SQLite, Stockfish, and
optional Maia/Lichess integrations. The practical setup is:

1. Keep the source code on GitHub.
2. Deploy the Docker web service from that GitHub repository to Render, Fly.io,
   Railway, a VPS, or another host that can run a long-lived container.
3. Point users at the deployed service URL.

## Render from GitHub

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint**.
3. Select the GitHub repository.
4. Render reads `render.yaml`, builds `Dockerfile`, and starts the web service.
5. Open the Render URL after the first deploy completes.

The Docker image installs Python dependencies and downloads the official
Stockfish Linux release during build. Application data is stored at
`/data/prepforge.sqlite3`; `render.yaml` mounts a persistent disk there.

## Local Docker Check

```powershell
docker build -t prepforge-chess .
docker run --rm -p 8765:8765 -v prepforge-data:/data prepforge-chess
```

Then open:

```text
http://127.0.0.1:8765
```

## Manual GitHub Upload

If you do not want to push with git, upload the repository files to GitHub using
the web UI. Do not upload local-only folders such as `data/`, `engines/`,
`build/`, `.venv/`, `.pytest_cache/`, or `.ruff_cache/`.

## About GitHub Pages

GitHub Pages can still be useful for a marketing/demo page or a redirect page,
but it cannot run this app's `/api/...` endpoints. A Pages-only version would
need to remove or rewrite the Python-backed features, including persistent
repertoires, Stockfish analysis, Lichess OAuth/fetching, and server-side
training state.
