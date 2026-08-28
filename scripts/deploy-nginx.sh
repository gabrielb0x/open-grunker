#!/usr/bin/env bash
# Open Grunker — install and enable the nginx vhost for grunker.g0x.dev.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="grunker.g0x.dev"
SRC="$ROOT/deploy/nginx/$SITE.conf"
AVAIL="/etc/nginx/sites-available/$SITE"
ENABLED="/etc/nginx/sites-enabled/$SITE"

[[ $EUID -eq 0 ]] || { echo "run as root: sudo bash $0"; exit 1; }
[[ -f "$SRC" ]]   || { echo "missing $SRC"; exit 1; }

# The vhost's root is the build, not the sources it is built from.
[[ -f "$ROOT/client/dist/index.html" ]] || {
  echo "no client build at $ROOT/client/dist — run 'npm run build' first"; exit 1; }

echo "==> installing $AVAIL"
install -m 0644 "$SRC" "$AVAIL"

if [[ ! -L "$ENABLED" ]]; then
  ln -sfn "$AVAIL" "$ENABLED"
  echo "==> enabled $SITE"
fi

# nginx (running as www-data) must be able to read the client and shared code.
echo "==> checking read access for www-data"
chmod o+rx "$ROOT" "$ROOT/client" "$ROOT/shared" 2>/dev/null || true
find "$ROOT/client" "$ROOT/shared" -type d -exec chmod o+rx {} + 2>/dev/null || true
find "$ROOT/client" "$ROOT/shared" -type f -exec chmod o+r  {} + 2>/dev/null || true

echo "==> nginx -t"
nginx -t

echo "==> reloading nginx"
systemctl reload nginx

cat <<MSG

nginx is configured for https://$SITE

  client    $ROOT/client/dist       (the build, served directly by nginx)
  api       https://$SITE/api/v1/   -> 127.0.0.1:7420
  realtime  wss://$SITE/ws          -> 127.0.0.1:7420

If the domain does not resolve yet, add a DNS record for "grunker" in the
g0x.dev zone (A/AAAA to this host, or a CNAME to g0x.dev). Behind Cloudflare,
leave the proxy on — WebSockets are supported — and keep SSL mode on "Full".
MSG
