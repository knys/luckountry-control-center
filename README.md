# Luckountry Control Center

Lightweight, read-only system dashboard for the Toshiba dynabook TX/66KWH. It listens on `0.0.0.0:3000` and refreshes telemetry every five seconds.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm start
```

Open `http://localhost:3000`. API endpoints are `GET /health` and `GET /api/system-status`.

## Production installation

Build first, then inspect and run the installer as root:

```sh
npm ci
npm run build
sudo ./ops/install.sh
```

The installer creates the unprivileged `luckountry` system account, installs the built application under `/opt`, enables `luckountry-control-center.service`, and grants only the fixed SMART wrapper permission to run as root. The API cannot choose a command or disk device.

```sh
systemctl status luckountry-control-center
journalctl -u luckountry-control-center -f
```
