"""Stage only the public landing page and its existing, demo-only artwork."""
import argparse
from pathlib import Path
from shutil import copyfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path, help="Empty destination for the GitHub Pages artifact")
dest = parser.parse_args().output
dest.mkdir(parents=True, exist_ok=True)
if any(dest.iterdir()):
    parser.error("Choose an empty output directory.")

# docs/ also contains development notes. Never use the whole tree as a site artifact.
files = {
    "index.html": "site/index.html",
    "style.css": "site/style.css",
    "sitemap.xml": "site/sitemap.xml",
    "assets/workspace.png": "docs/images/v0.2.18/meeting-detail.png",
    "assets/icon.png": "frontend/src-tauri/icons/128x128.png",
}
for target, source in files.items():
    path = dest / target
    path.parent.mkdir(exist_ok=True)
    copyfile(root / source, path)
