# Deploying to the cloud (Render + Neon, free tier)

The whole app runs as **one Render web service** behind a public HTTPS URL
(`https://<name>.onrender.com`) with a free **Neon** Postgres database:

| Piece | Where it runs | URL / port |
|---|---|---|
| Dashboard (React build) | served by the Node server | `https://<name>.onrender.com/` |
| REST API + login | Node server | `/api/*` |
| Live dashboard events | WebSocket | `wss://<name>.onrender.com/api/ws` (needs login) |
| RFID controllers (ESP32) | **secure WebSocket** | `wss://<name>.onrender.com/api/device-ws` |
| Database | Neon Postgres | `DATABASE_URL` secret |

## Why controllers use WSS instead of TCP / UDP / mDNS

A cloud host exposes only HTTPS on one port. The LAN transports the project used
(raw TCP `:5001`, UDP broadcast `:5002`, mDNS `rfid-app.local`) cannot cross the
internet, so in cloud mode they are switched off (`ENABLE_LAN_SERVICES=false`) and
the controller **dials out** to a fixed `wss://` hostname. Because the connection
is outbound, the controller works from any Wi-Fi network, behind any router/NAT,
with no port forwarding and no discovery. The JSON protocol (auth handshake,
detections, `auth_result`, ping/pong, offline `dump` sync, remote commands) is
unchanged; only the carrier changed. Local LAN mode still works
(`ENABLE_LAN_SERVICES` defaults to `true`, firmware `CLOUD_MODE 0`).

MQTT was not added: it needs a separate always-on broker and a second firmware
stack, and WSS already gives encrypted, authenticated, bidirectional delivery on
the same free service. If you later want MQTT, use a free HiveMQ Cloud / EMQX
Serverless broker (TLS on 8883) as a bridge.

## Free-tier limitations (read these)

* **Render free web service sleeps after ~15 min without inbound HTTP traffic**;
  the next request takes ~30-60 s to wake it. A sleeping server means controllers
  are offline and tags are only buffered in the ESP32's flash (it syncs them on
  reconnect via `dump`). Fix for free: an uptime monitor (below) pinging
  `/api/healthz` every 5 min keeps it awake.
* 750 free instance-hours/month, enough for one always-on service. Free services
  restart at least every ~24 h and on each deploy; controllers auto-reconnect.
* Render's own free Postgres **expires after 30 days**, hence Neon instead
  (free, no expiry; 0.5 GB; compute auto-suspends when idle, so the first query
  after idle can take ~1 s).
* Ephemeral disk: nothing is stored on the server's filesystem (all data is in
  Postgres), so restarts lose nothing.
* Single instance only: live device state is held in memory, so do not scale to 2+.
* TLS to the ESP32 is encrypted but, by default, the server certificate is not
  verified (no clock/CA on the board). Pin a root CA (`CLOUD_ROOT_CA` in the sketch)
  for production hardening.

## Security changes made for public hosting

* Every `/api` route now requires a dashboard login (previously none did). Public:
  `/api/healthz`, `/api/login`, `/api/auth/user`, `/api/logout`. Controllers may
  also use HTTP `POST /api/access-logs` and `POST /api/esp-devices/:id/heartbeat`
  with an `x-device-key: <DEVICE_AUTH_SECRET>` header.
* The dashboard WebSocket `/api/ws` requires the login cookie.
* The server **refuses to start in production** with the default `admin/admin`
  login (needs a 10+ char password) or without `DEVICE_AUTH_SECRET`.
* Constant-time credential checks; 10 failed logins / 15 min / IP lockout.
* Session cookie is `HttpOnly; Secure; SameSite=Lax`; CORS is closed by default.
* Controller packets (`detection`, `sync_response`, `ping`) are ignored until the
  device authenticates; unauthenticated sockets are dropped after 15 s.
* `.env` and `.env.*` are git-ignored; only `.env.example` is committed.

---

## Step 1 - Free database (Neon)

1. Sign up at <https://neon.tech> and create a project (region: **Singapore**).
2. Copy the connection string (it ends in `?sslmode=require`). Keep it secret;
   it becomes `DATABASE_URL` in Render. Tables are created automatically on each
   deploy (`drizzle-kit push` in the build command).

## Step 2 - Put the code on GitHub

Your remote is `https://github.com/Pise20Pratiksha/passive_RFID.git`. Make sure
`.env` is **not** staged, then commit and push:

```bash
git status                     # .env must NOT be listed
git add -A
git commit -m "Add cloud deployment (Render, WSS device link)"
git push origin main
```

> Your Wi-Fi SSID/password are hard-coded in the firmware. If this repo is public,
> treat that password as exposed: change it, and keep the real value out of Git.

## Step 3 - Render

1. Sign up at <https://render.com> with GitHub.
2. **New > Blueprint**, pick the repo, branch `main`. Render reads `render.yaml`.
3. When prompted, enter the secrets:
   * `DATABASE_URL`: the Neon string from step 1
   * `ADMIN_USERNAME` / `ADMIN_PASSWORD`: your dashboard login (10+ chars)
   * `DEVICE_AUTH_SECRET`: generate with
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
4. Apply. First build takes a few minutes. Result: `https://rfid-access-control.onrender.com`
   (your actual subdomain is shown in the dashboard).

Manual (no blueprint) equivalent: New > Web Service, Runtime **Node**, Region
Singapore, Instance **Free**, Health check path `/api/healthz`, and

```
Build command:
npm install -g pnpm@11.10.0 && pnpm install --frozen-lockfile --prod=false && pnpm --filter @workspace/db run push && pnpm --filter @workspace/rfid-dashboard run build && pnpm --filter @workspace/api-server run build

Start command:
node --enable-source-maps artifacts/api-server/dist/index.mjs
```

with the env vars from `render.yaml` (`NODE_VERSION=22`, `NODE_ENV=production`,
`ENABLE_LAN_SERVICES=false`, `COOKIE_SECURE=true` plus the four secrets).

## Step 4 - Keep it awake (free)

Create a free monitor at <https://uptimerobot.com>: HTTP(s), URL
`https://<name>.onrender.com/api/healthz`, interval 5 minutes.

## Step 5 - Flash the controller

In `firmware/dual_rfid_gate_logger/dual_rfid_gate_logger.ino`:

1. Arduino IDE > Library Manager: install **WebSockets** by Markus Sattler.
2. Set `CLOUD_HOST` to your host without `https://` (e.g. `rfid-access-control.onrender.com`).
3. Set `DEVICE_AUTH_KEY` to the exact `DEVICE_AUTH_SECRET` you gave Render
   (do not commit this edit).
4. Set your Wi-Fi SSID/password and upload. Any Wi-Fi with internet access works.

The TFT shows "Cloud Server" then "Online (Auth OK)"; the Devices page lists the
gate with transport `ws`.

## Testing

Replace `HOST` with your Render hostname.

```bash
# 1. Service up (public, no login). Expect {"status":"ok"}
curl https://HOST/api/healthz

# 2. API is locked. Expect HTTP 401
curl -i https://HOST/api/vehicles

# 3. HTTPS dashboard: open https://HOST/ and log in with ADMIN_USERNAME/PASSWORD
#    (padlock = valid TLS certificate; the live badge turns "connected").

# 4. Controller link without hardware (needs: npm i -g wscat). Authenticate:
wscat -c wss://HOST/api/device-ws
> {"type":"auth_request","deviceId":"ESP32-GATE-TEST","token":"<DEVICE_AUTH_SECRET>","name":"Test Gate","nvsCount":0}
# expect: {"type":"auth_response","status":"authenticated",...}
> {"type":"detection","epc":"E2000000TEST0001","direction":"IN","deviceId":"ESP32-GATE-TEST"}
# expect an auth_result reply; the Logs / Dashboard pages update live,
# and Devices shows "ESP32-GATE-TEST" online. A wrong token returns "unauthorized".

# 5. Remote command from the dashboard session, or with the cookie:
#    POST /api/devices/ESP32-GATE-TEST/command {"cmd":"open_gate"} -> the wscat window receives it.

# 6. Cross-network: run the real ESP32 on a phone hotspot (a different network
#    than your PC) and tap an RFID tag; the entry should appear in the dashboard.

# 7. Persistence: Render dashboard > Manual Deploy > Restart. Data and users
#    remain (Postgres) and the controller reconnects by itself within seconds.
```

Verified locally against a clean database in production mode: login enforcement,
dashboard-WS auth, device auth/reject, detection to `auth_result`, live push to
the dashboard, remote command delivery, device-key HTTP ingest, offline marking
(21/21 checks).

## Troubleshooting

* **Build fails at `db run push`**: `DATABASE_URL` missing/incorrect, or Neon needs `?sslmode=require`.
* **Service crashes on start**: log says which of `ADMIN_PASSWORD` / `DEVICE_AUTH_SECRET` is missing or weak.
* **Controller shows "Auth Failed"**: `DEVICE_AUTH_KEY` differs from `DEVICE_AUTH_SECRET`.
* **Controller never connects**: wrong `CLOUD_HOST`, no internet on that Wi-Fi, or the service is asleep (first connect after sleep retries automatically).
* **Dashboard loads but is empty / logged out**: use the `https://` URL (the cookie is `Secure`).

## Local development is unchanged

```bash
pnpm install
pnpm --filter @workspace/db run push
pnpm run dev        # LAN services on, admin/admin unless .env says otherwise
```
