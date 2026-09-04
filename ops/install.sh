#!/bin/sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run as root" >&2; exit 1; }
id luckountry >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin luckountry
install -d -o root -g root -m 0755 /opt/luckountry-control-center /opt/luckountry-control-center/dist /usr/local/libexec
install -d -o root -g root -m 0750 /etc/luckountry-control-center
install -d -o luckountry -g luckountry -m 0770 /var/lib/luckountry-control-center
install -d -o user -g user -m 0750 /home/user/.lcc-commission-watcher
if ! test -d /home/user/.lcc-commission-watcher/workspace/.git; then
  runuser -u user -- git clone --quiet https://github.com/knys/luckountry-control-center.git /home/user/.lcc-commission-watcher/workspace
fi
cp -R dist/. /opt/luckountry-control-center/dist/
revision=$(git rev-parse HEAD)
printf '%s\n' "$revision" > /opt/luckountry-control-center/REVISION
printf '%s\n' "$revision" > /var/lib/luckountry-control-center/expected-revision
chown root:root /opt/luckountry-control-center/REVISION
chown luckountry:luckountry /var/lib/luckountry-control-center/expected-revision
chmod 0644 /opt/luckountry-control-center/REVISION
chmod 0640 /var/lib/luckountry-control-center/expected-revision
token_file=/etc/luckountry-control-center/self-commissioning
if ! test -s "$token_file"; then
  umask 077
  token=$(openssl rand -hex 32)
  printf 'SELF_COMMISSIONING_CONTROL_TOKEN=%s\nSELF_COMMISSIONING_ENABLED=true\n' "$token" > "$token_file"
  token=
fi
chown root:root "$token_file"
chmod 0600 "$token_file"
install -o root -g root -m 0755 ops/luckountry-smart-status /usr/local/libexec/luckountry-smart-status
install -o root -g root -m 0755 ops/lcc-tx-maintenance /usr/local/libexec/lcc-tx-maintenance
install -o root -g root -m 0755 ops/lcc-watchdog-recovery /usr/local/libexec/lcc-watchdog-recovery
install -o root -g root -m 0440 ops/luckountry-control-center.sudoers /etc/sudoers.d/luckountry-control-center
visudo -cf /etc/sudoers.d/luckountry-control-center
install -o root -g root -m 0644 ops/luckountry-control-center.service /etc/systemd/system/luckountry-control-center.service
install -o root -g root -m 0644 ops/luckountry-commission-watcher.service /etc/systemd/system/luckountry-commission-watcher.service
install -o root -g root -m 0644 ops/luckountry-self-commissioning-watchdog.service /etc/systemd/system/luckountry-self-commissioning-watchdog.service
install -o root -g root -m 0644 ops/luckountry-self-commissioning-watchdog.timer /etc/systemd/system/luckountry-self-commissioning-watchdog.timer
systemctl daemon-reload
systemctl enable luckountry-control-center.service
systemctl enable luckountry-commission-watcher.service
systemctl enable luckountry-self-commissioning-watchdog.timer
systemctl restart luckountry-control-center.service
systemctl restart luckountry-commission-watcher.service
systemctl restart luckountry-self-commissioning-watchdog.timer
