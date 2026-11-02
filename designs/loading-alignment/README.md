# Menu and loading review

From the repository root, rebuild the download archive and serve the gallery:

```powershell
py designs/loading-alignment/package-review.py
py -m http.server 9029 --bind 127.0.0.1 --directory designs/loading-alignment
```

Open <http://127.0.0.1:9029/>. Use the page, viewport and loading-state controls
to inspect each pair. Raw CSS-pixel measurements are shown below the screenshots
and preserved in the adjacent JSON files. The ZIP is generated, not tracked.

[Capture provenance](provenance.md) describes fixtures and environment differences.
The earlier functional walkthrough preserves its original captures; its old
toolbar locations are superseded by the current More menu.
