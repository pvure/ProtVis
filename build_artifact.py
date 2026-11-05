"""Bundle web/ + demos into one self-contained HTML file (no server needed).

    python build_artifact.py [out.html]
"""

import json
import re
import sys
from pathlib import Path

WEB = Path(__file__).parent / "web"
out = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/protvis.html")

html = (WEB / "index.html").read_text()
index = json.loads((WEB / "demos/index.json").read_text())
data = {d["key"]: json.loads((WEB / f"demos/{d['key']}.json").read_text()) for d in index}
for d in data.values():  # drop to 3 decimals: halves the payload, invisible on screen
    d["emb3d"] = [[round(v, 3) for v in p] for p in d["emb3d"]]
    d["layers2d"] = [[[round(v, 3) for v in p] for p in layer] for layer in d["layers2d"]]

app = (WEB / "app.js").read_text()
demos = "<script>window.PROTVIS_DEMOS=" + json.dumps({"index": index, "data": data}, separators=(",", ":")) + "</script>"

head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
head = re.sub(r'<meta (charset|name="viewport")[^>]*>\s*', "", head)
body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
body = body.replace("<!--DEMO-DATA-->", demos)
body = body.replace('<script type="module" src="app.js"></script>', f'<script type="module">\n{app}\n</script>')

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(head.strip() + "\n" + body.strip() + "\n")
print(f"{out}  {out.stat().st_size / 1e6:.2f} MB")
