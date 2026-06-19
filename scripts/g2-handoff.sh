#!/usr/bin/env sh
# g2-handoff.sh — pin the session you're working on so the G2 glasses pick it up.
#
# The backend keeps a single "active session" handoff record. Run this before
# you leave the desk; on its next launch (foreground ▶ Continuar, or the
# headless background WebView) the glasses GET the handoff and auto-resume that
# session's mirror — so the "Claude te espera" banner can fire with the phone
# pocketed.
#
# Usage:
#   ./scripts/g2-handoff.sh             # auto-detect the most recent session
#   ./scripts/g2-handoff.sh <sessionId> # pin an explicit session id
#
# Env:
#   PORT   backend port (default 8787)
#
# Requires: python3 (to read the token + parse JSON), curl.

set -eu

PORT="${PORT:-8787}"
CONFIG="$HOME/.cc-g2/config.json"
PROJECTS_DIR="$HOME/.claude/projects"

# --- 1. resolve the session id ------------------------------------------------
SID="${1:-}"
if [ -z "$SID" ]; then
  # Newest *.jsonl transcript under ~/.claude/projects, EXCLUDING subagent
  # transcripts (they're not the real session you're driving).
  NEWEST="$(
    find "$PROJECTS_DIR" -name '*.jsonl' -not -path '*/subagents/*' -print0 2>/dev/null \
      | xargs -0 ls -t 2>/dev/null \
      | head -1
  )"
  if [ -z "$NEWEST" ]; then
    echo "g2-handoff: no session transcripts found under $PROJECTS_DIR" >&2
    exit 1
  fi
  # sessionId = basename without the .jsonl extension.
  SID="$(basename "$NEWEST" .jsonl)"
fi

# --- 2. read the bearer token -------------------------------------------------
if [ ! -f "$CONFIG" ]; then
  echo "g2-handoff: config not found at $CONFIG (is the backend set up?)" >&2
  exit 1
fi
TOKEN="$(
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("token",""))' "$CONFIG"
)"
if [ -z "$TOKEN" ]; then
  echo "g2-handoff: no token in $CONFIG" >&2
  exit 1
fi

# --- 3. POST the handoff ------------------------------------------------------
URL="http://127.0.0.1:${PORT}/api/native/handoff"
RESP="$(
  curl -fsS -X POST "$URL" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"${SID}\"}" 2>/dev/null
)" || {
  echo "g2-handoff: POST to $URL failed (is the backend running on port ${PORT}?)" >&2
  exit 1
}

# --- 4. confirm (with the session title, best-effort) -------------------------
TITLE=""
GET_RESP="$(
  curl -fsS "$URL" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null || true
)"
if [ -n "$GET_RESP" ]; then
  TITLE="$(
    printf '%s' "$GET_RESP" \
      | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("title","") or "")
except Exception:
    print("")' 2>/dev/null || true
  )"
fi

if [ -n "$TITLE" ]; then
  echo "g2-handoff: pinned ${SID}"
  echo "            \"${TITLE}\""
  echo "            → the glasses will resume this session on next launch."
else
  echo "g2-handoff: pinned ${SID} → the glasses will resume it on next launch."
fi
