#!/bin/sh
set -eu
test "$(id -u)" -eq 0 || { echo "Run as root" >&2; exit 1; }
id luckountry >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin luckountry
install -d -o root -g root -m 0755 /opt/luckountry-control-center /opt/luckountry-control-center/dist /usr/local/libexec
install -d -o root -g root -m 0750 /etc/luckountry-control-center
install -d -o luckountry -g luckountry -m 0770 /var/lib/luckountry-control-center
cp -R dist/. /opt/luckountry-control-center/dist/
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
install -o root -g root -m 0440 ops/luckountry-control-center.sudoers /etc/sudoers.d/luckountry-control-center
visudo -cf /etc/sudoers.d/luckountry-control-center
install -o root -g root -m 0644 ops/luckountry-control-center.service /etc/systemd/system/luckountry-control-center.service
systemctl daemon-reload
systemctl enable luckountry-control-center.service
systemctl restart luckountry-control-center.service
