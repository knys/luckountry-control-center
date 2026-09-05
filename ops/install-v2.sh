#!/bin/sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run as root" >&2; exit 1; }
revision=$(git rev-parse HEAD)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
root=/opt/luckountry-control-center-v2
release=$root/releases/$revision
backup=$root/backups/$stamp
install -d -o root -g root -m 0755 "$release" "$backup"
install -d -o user -g luckountry -m 0770 /var/lib/luckountry-control-center/v2 /home/user/.lcc-v2 /home/user/.lcc-v2/workspaces
cp -a dist "$release/"
test -f "$release/dist/config/products.json" || { echo "v2 product manifest missing from release" >&2; exit 1; }
cp -a /etc/systemd/system/luckountry-control-center.service "$backup/" 2>/dev/null || true
cp -a /etc/systemd/system/luckountry-commission-watcher.service "$backup/" 2>/dev/null || true
cp -a /etc/systemd/system/luckountry-self-commissioning-watchdog.service "$backup/" 2>/dev/null || true
cp -a /etc/systemd/system/luckountry-self-commissioning-watchdog.timer "$backup/" 2>/dev/null || true
cp -a /etc/systemd/system/lcc-final-commission-bootstrap.service "$backup/" 2>/dev/null || true
test ! -e "$root/current" || readlink -f "$root/current" > "$backup/previous-release"
ln -sfn "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
install -o root -g root -m 0644 ops/luckountry-control-center-v2.service /etc/systemd/system/luckountry-control-center-v2.service
install -o root -g root -m 0755 ops/lcc-v2-deploy /usr/local/sbin/lcc-v2-deploy
install -o root -g root -m 0755 ops/lcc-v2-manifest-sync /usr/local/sbin/lcc-v2-manifest-sync
install -o root -g root -m 0755 ops/lcc-v2-manifest-canary /usr/local/sbin/lcc-v2-manifest-canary
install -o root -g root -m 0440 ops/luckountry-control-center-v2.sudoers /etc/sudoers.d/luckountry-control-center-v2
/usr/sbin/visudo -cf /etc/sudoers.d/luckountry-control-center-v2
systemctl daemon-reload
runuser -u user -- env HOST=127.0.0.1 PORT=3001 LCC_V2_DATA_DIRECTORY=/tmp/lcc-v2-preflight-$$ LCC_PRODUCTS_MANIFEST="$release/dist/config/products.json" /usr/bin/node "$release/dist/v2/server.js" &
canary=$!
ready=false
i=0
while test "$i" -lt 30; do
  if curl -fsS http://127.0.0.1:3001/health >/dev/null; then ready=true; break; fi
  i=$((i+1)); sleep 1
done
kill "$canary" 2>/dev/null || true
wait "$canary" 2>/dev/null || true
test "$ready" = true || { echo "v2 preflight failed" >&2; exit 1; }
systemctl stop luckountry-control-center.service
systemctl enable luckountry-control-center-v2.service
systemctl restart luckountry-control-center-v2.service
i=0
while test "$i" -lt 30; do
  if curl -fsS http://127.0.0.1:3000/health | grep -q luckountry-control-center-v2; then break; fi
  i=$((i+1)); sleep 1
done
if ! curl -fsS http://127.0.0.1:3000/health | grep -q luckountry-control-center-v2; then
  systemctl disable --now luckountry-control-center-v2.service || true
  systemctl start luckountry-control-center.service
  echo "v2 health failed; v1 restored" >&2
  exit 1
fi
systemctl disable --now luckountry-commission-watcher.service || true
systemctl disable --now luckountry-self-commissioning-watchdog.timer || true
systemctl disable --now lcc-final-commission-bootstrap.service || true
printf '%s\n' "$stamp" > "$root/LAST_BACKUP"
echo "v2 deployed revision $revision; rollback backup $backup"
