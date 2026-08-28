#!/usr/bin/env bash
# Open Grunker — one-shot setup: dependencies, database, service, nginx.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }

say "checking Node"
command -v node >/dev/null || { echo "Node.js 22.5+ is required"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 5) )); then
  echo "Node $(node -v) is too old — 22.5+ is needed for the built-in SQLite module"
  exit 1
fi
echo "node $(node -v) ok"

say "installing dependencies"
npm install --no-audit --no-fund

say "building the client"
npm run build

say "preparing configuration"
[[ -f .env ]] || { cp .env.example .env; echo "created .env from .env.example"; }

say "initialising the database"
node scripts/db-cli.js init

if [[ $EUID -eq 0 ]]; then
  say "installing the systemd service"
  bash scripts/deploy-service.sh
  say "installing the nginx site"
  bash scripts/deploy-nginx.sh
else
  cat <<MSG

Setup finished. To install the service and nginx site, re-run as root:

  sudo bash scripts/setup.sh

Or start it in the foreground right now:

  npm start        then open http://localhost:7420
MSG
fi
