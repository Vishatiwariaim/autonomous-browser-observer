# Deploy ABO Observer backend (LAN / VPS)

Yes: **backend ek server pe**, users sirf **extension** lagayein — kaam karega.

## Architecture

```
[Dev browser + Extension]  --->  http(s)://YOUR_SERVER:3847  (Observer)
                                      |
                                      +-- SQLite /data
                                      +-- Dashboard
                                      +-- Autopilot / ACP (optional)
```

## Option A — Same office PC / LAN (sabse simple)

### Server PC pe
```powershell
cd "C:\Users\vishal.tiwari\Desktop\browser obervation"
copy .env.example .env
# .env me set karo:
#   OBSERVER_HOST=0.0.0.0
#   ABO_API_TOKEN=some-long-secret
#   OBSERVER_PUBLIC_URL=http://YOUR_LAN_IP:3847

npm install
npm start
```

Firewall: port **3847** allow (inbound).

Apna LAN IP dekho:
```powershell
ipconfig
```
e.g. `http://192.168.1.50:3847`

### User / dusre PC pe
1. `npm run build:extension` (ya server se `extension/dist` copy)
2. Chrome → Load unpacked → `extension/dist`
3. Extension **Options**:
   - Observer URL = `http://192.168.1.50:3847`
   - API token = same `ABO_API_TOKEN`
4. Popup → **Connected**

## Option B — Docker (VPS / always-on)

```powershell
$env:ABO_API_TOKEN="some-long-secret"
$env:OBSERVER_PUBLIC_URL="http://YOUR_PUBLIC_IP:3847"
docker compose up -d --build
```

Dashboard: `http://YOUR_PUBLIC_IP:3847/`

## Option C — Cloud (Railway / Render / Fly / AWS)

1. Repo push GitHub
2. Docker deploy, expose port 3847
3. Set env: `OBSERVER_HOST=0.0.0.0`, `ABO_API_TOKEN=...`, `OBSERVER_PUBLIC_URL=https://your-app.example`
4. Extension Options me woh URL + token

> Public internet pe **HTTPS + strong token** use karo. Browser events sensitive ho sakte hain.

## Extension build with default remote URL

```powershell
$env:ABO_DEFAULT_OBSERVER_URL="http://192.168.1.50:3847"
$env:ABO_DEFAULT_API_TOKEN="some-long-secret"
npm run build:extension
```

Phir users ko sirf `extension/dist` Load unpacked dena.

## Verify

```powershell
curl http://YOUR_SERVER:3847/health
curl http://YOUR_SERVER:3847/api/extension/ping
```

Popup **Connected** + dashboard **EXTENSION CONNECTION**.

## Limits

| Item | Note |
| --- | --- |
| Sirf extension | Nahi — Observer server chahiye |
| Autopilot / Cursor fix | Server pe Cursor CLI + repo access chahiye; warna observe-only |
| Token | `ABO_API_TOKEN` set karo warna koi bhi LAN pe post kar sakta hai |
| chrome:// pages | Capture nahi hota |

## Quick LAN start script

```powershell
.\scripts\deploy-lan.ps1
```
