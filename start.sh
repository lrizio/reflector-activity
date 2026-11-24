#!/bin/sh
# Reflector Activity launcher for macOS / Linux. Needs Node.js 24 or newer.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8787}"; export PORT

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js 24 or newer from https://nodejs.org"; exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  echo "Your Node.js is too old; Reflector Activity needs Node.js 24 or newer."; exit 1
fi
[ -d node_modules ] || npm install --omit=dev || exit 1
mkdir -p data

if [ ! -f config.json ]; then
  echo
  echo "First-time setup: the YSF tab can listen (listen-only) to the busiest reflectors."
  echo "That needs YOUR OWN amateur callsign. Press Enter to skip."
  printf "Your callsign: "
  read -r raw
  call=$(printf '%s' "$raw" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z0-9' | cut -c1-10)
  printf '{\n  "callsign": "%s",\n  "listenTop": 50\n}\n' "$call" > config.json
fi

echo "Starting Reflector Activity on http://localhost:$PORT  (Ctrl+C to stop)"
case "$(uname)" in
  Darwin) [ -z "$NO_BROWSER" ] && (sleep 2; open "http://localhost:$PORT") & ;;
  *) [ -z "$NO_BROWSER" ] && command -v xdg-open >/dev/null 2>&1 && (sleep 2; xdg-open "http://localhost:$PORT" >/dev/null 2>&1) & ;;
esac
node server.mjs 2>&1 | tee data/server.log
