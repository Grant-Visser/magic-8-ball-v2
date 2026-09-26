# Hosting Magic 8 Ball v2 on Proxmox LXC

## One-Command Install

From your **Proxmox host shell** as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Grant-Visser/magic-8-ball-v2/main/proxmox/magic-8-ball.sh)"
```

The script will:
- Ask for **Default** or **Advanced** setup
- Prompt you to select template and disk storage from your available pools
- Create a **Debian 13 LXC** (1 core, 512MB RAM, 4GB disk)
- Install Node.js 22 LTS, clone the repo, build frontend + backend
- Configure Nginx (port 80 → app on 8787) and a systemd service
- Print the URL when done

**Default mode** — just pick storage, everything else is automatic.
**Advanced mode** — full control over CT ID, hostname, CPU, RAM, disk size, bridge.

> **Note:** after install, add your OpenRouter API key or the ball stays cloudy:
> ```bash
> pct exec <CTID> -- nano /opt/magic-8-ball-v2/server/.env   # set OPENROUTER_API_KEY
> pct exec <CTID> -- systemctl restart magic-8-ball
> ```

---

## Upgrading

Run this from the Proxmox host (upgrade script: git pull → deps → rebuild → restart):

```bash
pct exec <CTID> -- bash < <(curl -fsSL https://raw.githubusercontent.com/Grant-Visser/magic-8-ball-v2/main/proxmox/magic-8-ball-upgrade.sh)
```

Or manually:

```bash
pct exec <CTID> -- bash -c 'cd /opt/magic-8-ball-v2 && git pull && cd server && npm ci --silent && cd ../client && npm ci --silent && npm run build && systemctl restart magic-8-ball'
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Service won't start | `journalctl -u magic-8-ball -n 50` |
| Nginx 502 bad gateway | `systemctl status magic-8-ball` |
| Build fails | `pct exec <CTID> -- node --version` — should be v22.x |
| Answers are "cloudy" | Check `OPENROUTER_API_KEY` in `/opt/magic-8-ball-v2/server/.env` |
| Model errors | Check `JEV_MODEL` in `.env` (default: `typesafe/jev-router`) |

---

## File Locations

| Path | Contents |
|------|----------|
| `/opt/magic-8-ball-v2/` | App root (git clone) |
| `/opt/magic-8-ball-v2/server/index.js` | Express backend (API + serves frontend) |
| `/opt/magic-8-ball-v2/server/.env` | Config — `OPENROUTER_API_KEY`, `JEV_MODEL`, `PORT` |
| `/opt/magic-8-ball-v2/client/dist/` | React build output (served by Express) |
| `/etc/systemd/system/magic-8-ball.service` | systemd unit |
| `/etc/nginx/sites-available/magic-8-ball` | Nginx config (reverse proxy :80 → :8787) |
