#!/bin/sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run as root" >&2; exit 1; }
systemctl disable --now luckountry-control-center-v2.service || true
systemctl enable --now luckountry-control-center.service
systemctl enable --now luckountry-commission-watcher.service
systemctl enable --now luckountry-self-commissioning-watchdog.timer
test ! -f /etc/systemd/system/lcc-final-commission-bootstrap.service || systemctl enable --now lcc-final-commission-bootstrap.service
curl -fsS http://127.0.0.1:3000/health >/dev/null
echo "v1 services restored; v2 state and releases retained"
