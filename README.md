# Luckountry Control Center

Lightweight, read-only device dashboard for Luckountry's GTX1060 PC, TOBIE BOX, and TX66KWH. It listens on `0.0.0.0:3000` and refreshes telemetry every five seconds.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm start
```

Open `http://localhost:3000`. API endpoints are `GET /health`, `GET /api/devices`, and the backward-compatible `GET /api/system-status`.

## Remote device agents

The Control Center polls small read-only JSON agents over the LAN; it never runs SSH or remote commands. Configure endpoints without embedding host details in source:

```sh
DEVICE_GTX1060_URL=http://192.168.x.x:9100
DEVICE_TOBIE_URL=http://192.168.x.x:9100
```

`agents/tobie-agent.py` uses only the Python standard library. `agents/windows-agent.ps1` uses built-in PowerShell/CIM APIs. Both expose only `GET /health` and `GET /telemetry`; their optional `services` object is reserved for future DRAW/WALL/BATTLE/RACE status. They default to loopback. Bind each agent to its specific LAN address and restrict port 9100 to the local subnet with the host firewall. There is currently no authentication; the endpoint URL/provider boundary allows token authentication to be added later.

Fresh telemetry is `ONLINE`. CPU >= 85%, temperature >= 80°C, RAM >= 85%, disk >= 90%, or data older than 20 seconds is `WARNING`. Data older than 60 seconds, an unconfigured endpoint, or an endpoint with no prior successful response is `OFFLINE`.

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
