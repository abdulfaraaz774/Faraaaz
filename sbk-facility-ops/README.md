# SBK Facility Ops

A web app for SBK Real Estate's site teams. Staff sign in on their phones and record:

- **Attendance**: check in and check out, with GPS location if the phone allows it.
- **Bin disposal**: site, bin room, waste type, number of bins, and an optional photo.
- **DEWA meter readings**: electricity and water. The app remembers each meter's previous reading, works out consumption, and warns you if a reading is lower than the last one.
- **Security patrol**: a checkpoint checklist for each site, marked "All clear" or "Issue found" with a note, a photo and GPS.

Supervisors and admins also get a dashboard (who is on duty, bins today, readings and patrol progress), **Records & reports** with filters and **CSV export** for Excel, and an **Admin** screen for staff accounts, sites and checkpoints.

Data is kept in a single SQLite database file on the server, so you don't need a separate database server. Phones can add the app to the home screen like a normal app (PWA).

## Roles

| Role | Can do |
|---|---|
| Staff | Record attendance, bins, meters and patrols, and see their own records |
| Supervisor | All of the above, plus everyone's records, the dashboard and CSV export |
| Admin | All of the above, plus managing users, sites and checkpoints and deleting records |

---

## Run it on your own computer (to try it)

You need **Node.js 22.13 or newer** (https://nodejs.org).

```bash
cd sbk-facility-ops
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

Open http://localhost:3000 and sign in as `admin` with the password you chose. If you don't set `ADMIN_PASSWORD`, the app makes up a password on first start and prints it in the terminal.

---

## Put it on a real server (recommended: a VPS with Docker)

This works on any Linux VPS, for example DigitalOcean, Hetzner, AWS Lightsail, Contabo or a local UAE provider. The smallest plan (1 vCPU, 1 GB RAM) is enough.

> **You need HTTPS.** Phones only allow GPS and the camera on secure (https://) sites. The setup below gets a free certificate for you automatically.

1. **Get a domain or subdomain**, for example `ops.sbkrealestate.com`. In your DNS settings, add an **A record** that points it to your server's IP address.
2. **Install Docker** on the server:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. **Copy this folder to the server**, using `git clone` or `scp -r sbk-facility-ops user@server:~`.
4. **Configure it:**
   ```bash
   cd sbk-facility-ops
   cp .env.example .env
   nano .env        # set DOMAIN and ADMIN_PASSWORD
   ```
5. **Start it:**
   ```bash
   docker compose up -d
   ```
   Wait about a minute, then open `https://your-domain`. Caddy gets the HTTPS certificate and renews it automatically.

**Update after changing code:** `docker compose up -d --build`
**See logs:** `docker compose logs -f app`
**Stop:** `docker compose down` (your data is kept in the `sbk-data` volume)

### Alternative: no Docker (Node, systemd and nginx)

```bash
sudo useradd -r -s /usr/sbin/nologin sbkops
sudo mkdir -p /opt/sbk-facility-ops /var/lib/sbk-ops && sudo chown sbkops /var/lib/sbk-ops
# copy the files into /opt/sbk-facility-ops, then:
cd /opt/sbk-facility-ops && sudo npm ci --omit=dev
sudo cp .env.example .env && sudo nano .env
sudo cp deploy/sbk-ops.service /etc/systemd/system/
sudo systemctl enable --now sbk-ops
```
Then set up nginx using `deploy/nginx.conf` and get HTTPS with `sudo certbot --nginx -d your-domain`.

### Alternative: a managed platform (Render, Railway, Fly.io)

- Build command: `npm ci`. Start command: `npm start`. Node version 22 or newer.
- **Attach a persistent disk/volume** and set `DATA_DIR` to its mount path, for example `/data`. Without one, all data is lost every time the platform redeploys.
- Set `ADMIN_PASSWORD` and `APP_TZ=Asia/Dubai` as environment variables.
- These platforms provide HTTPS for you.

> Shared PHP-only hosting, such as basic cPanel plans, **cannot** run this app because it needs Node.js. Use a VPS or one of the platforms above.

---

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the app listens on |
| `DATA_DIR` | `./data` | Where the database and photos are stored |
| `ADMIN_USERNAME` | `admin` | First admin username (used only on first start) |
| `ADMIN_PASSWORD` | random | First admin password (used only on first start) |
| `APP_TZ` | `Asia/Dubai` | Time zone for "today", reports and exports |
| `SESSION_DAYS` | `14` | How long a login lasts |
| `TRUST_PROXY` | private networks | Which reverse proxies the app trusts for the client's IP address and https |

## Backups

Everything is stored in `DATA_DIR`: the `sbk-ops.db` database and the `uploads/` photos folder. Back it up daily with `deploy/backup.sh`; the script's comments explain how to schedule it with cron. To restore, stop the app, put the files back, and start it again.

## First steps after going live

1. Sign in as admin, go to **Me**, then **Change password**.
2. Go to **Me**, then **Admin settings**. Rename "Main Building" to your real site, add your other sites, and set the patrol checkpoints for each site.
3. Create an account for each staff member, guard and supervisor.
4. Ask staff to open the site on their phone and choose **Add to Home Screen**.

## Project layout

```
server.js            API, sign-in, database (Express + built-in node:sqlite)
public/              the app's screens (plain HTML/CSS/JS, no build step)
Dockerfile           container image
docker-compose.yml   app + Caddy (automatic HTTPS)
deploy/              nginx config, systemd service, backup script
```
