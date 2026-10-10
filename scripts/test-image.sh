#!/usr/bin/env bash
# Send one image to a running cursor-openai server.
#
# Usage: scripts/test-image.sh <image-file-or-http-url> [prompt...]
# Env:   BASE_URL (default http://127.0.0.1:8787)
#        API_KEY or PROXY_KEY (default local-dev-secret)
#        MODEL (default composer-2.5)
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
API_KEY="${API_KEY:-${PROXY_KEY:-local-dev-secret}}"
MODEL="${MODEL:-composer-2.5}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <image-file-or-http-url> [prompt...]" >&2
  exit 2
fi

target=$1
shift
prompt=${*:-Describe this image in one sentence.}

body=$(mktemp)
trap 'rm -f "$body"' EXIT

python3 - "$target" "$prompt" "$MODEL" "$body" <<'PY'
import base64, json, mimetypes, sys
from pathlib import Path

target, prompt, model, out = sys.argv[1:5]
if target.startswith(("http://", "https://")):
    url = target
else:
    path = Path(target)
    if not path.is_file():
        raise SystemExit(f"not a file: {target}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if mime == "image/jpg":
        mime = "image/jpeg"
    if not mime.startswith("image/"):
        raise SystemExit(f"not an image ({mime}): {target}")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    url = f"data:{mime};base64,{encoded}"

payload = {
    "model": model,
    "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": url}},
        ],
    }],
}
Path(out).write_text(json.dumps(payload))
PY

tmp=$(mktemp)
trap 'rm -f "$body" "$tmp"' EXIT
status=$(curl -sS --max-time 300 \
  -o "$tmp" \
  -w "%{http_code}" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d @"$body" \
  "${BASE_URL%/}/v1/chat/completions")

python3 - "$status" "$tmp" <<'PY'
import json, sys
status, path = sys.argv[1], sys.argv[2]
raw = open(path, encoding="utf-8").read()
try:
    payload = json.loads(raw)
except json.JSONDecodeError:
    print(raw)
    raise SystemExit(0 if status == "200" else 1)
if status != "200":
    print(json.dumps(payload, indent=2))
    raise SystemExit(1)
message = payload["choices"][0]["message"]
text = message.get("content")
print(text if text else json.dumps(message, indent=2))
PY
