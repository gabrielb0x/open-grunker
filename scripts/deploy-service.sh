#!/usr/bin/env bash
# Open Grunker — install, enable and start the systemd service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="open-grunker.service"
SRC="$ROOT/deploy/systemd/$UNIT"

[[ $EUID -eq 0 ]] || { echo "run as root: sudo bash $0"; exit 1; }
[[ -f "$SRC" ]]   || { echo "missing $SRC"; exit 1; }

RUN_USER="$(awk -F= '/^User=/{print $2}' "$SRC")"
echo "==> service user: $RUN_USER"

mkdir -p "$ROOT/data"
chown -R "$RUN_USER":"$RUN_USER" "$ROOT/data"
chmod 750 "$ROOT/data"

echo "==> installing /etc/systemd/system/$UNIT"
install -m 0644 "$SRC" "/etc/systemd/system/$UNIT"

systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"
sleep 2

if systemctl is-active --quiet "$UNIT"; then
  echo "==> open-grunker is running"
  systemctl --no-pager --lines=8 status "$UNIT" || true
else
  echo "!! service failed to start; last 30 log lines:"
  journalctl -u "$UNIT" --no-pager --lines=30
  exit 1
fi

cat <<MSG

Service commands
  sudo systemctl status  open-grunker
  sudo systemctl restart open-grunker
  sudo systemctl stop    open-grunker
  journalctl -u open-grunker -f
MSG
