#!/usr/bin/env bash
# ==============================================================================
# Magic 8 Ball v2 — Container Install Script
# Runs INSIDE the LXC container. Called by magic-8-ball.sh on the host.
# ==============================================================================
set -euo pipefail

YW="\033[33m" GN="\033[1;92m" RD="\033[01;31m" BL="\033[36m" CL="\033[m"
CM="${GN}✓${CL}" CROSS="${RD}✗${CL}" TAB="  "

msg_info()  { echo -e "${TAB}${YW}○${CL} ${1}..."; }
msg_ok()    { echo -e "${TAB}${CM} ${1}"; }
msg_error() { echo -e "${TAB}${CROSS} ${RD}${1}${CL}"; exit 1; }

REPO_URL="https://github.com/Grant-Visser/magic-8-ball-v2.git"
APP_DIR="/opt/magic-8-ball-v2"
NODE_MAJOR=22

# ── System update ─────────────────────────────────────────────────────────────
msg_info "Updating system"
apt-get update -qq
apt-get upgrade -y -qq
msg_ok "System updated"

# ── Dependencies ──────────────────────────────────────────────────────────────
msg_info "Installing dependencies"
apt-get install -y -qq curl git nginx ca-certificates gnupg
msg_ok "Dependencies installed"

# ── Node.js 22 LTS via NodeSource ─────────────────────────────────────────────
msg_info "Installing Node.js $NODE_MAJOR LTS"
curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs
msg_ok "Node.js $(node -v) installed"

# ── Clone repo ────────────────────────────────────────────────────────────────
msg_info "Cloning Magic 8 Ball v2"
git clone -q "$REPO_URL" "$APP_DIR"
msg_ok "Repository cloned"

# ── Server dependencies ───────────────────────────────────────────────────────
msg_info "Installing backend dependencies"
cd "$APP_DIR/server"
npm ci --silent
msg_ok "Backend dependencies installed"

# ── Frontend install + build ──────────────────────────────────────────────────
msg_info "Building frontend (this may take a minute)"
cd "$APP_DIR/client"
npm ci --silent
npm run build >/dev/null 2>&1
msg_ok "Frontend built to $APP_DIR/client/dist"

# ── Environment file ──────────────────────────────────────────────────────────
msg_info "Setting up environment"
cp "$APP_DIR/server/.env.example" "$APP_DIR/server/.env"
chmod 600 "$APP_DIR/server/.env"
msg_ok ".env created at $APP_DIR/server/.env"

# Allow the key to be injected non-interactively at install time
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  sed -i "s#^OPENROUTER_API_KEY=.*#OPENROUTER_API_KEY=${OPENROUTER_API_KEY}#" "$APP_DIR/server/.env"
  msg_ok "OPENROUTER_API_KEY set from install environment"
else
  msg_ok "NOTE: add your OpenRouter key to $APP_DIR/server/.env after install"
fi

# ── Nginx (reverse proxy :80 -> :8787) ────────────────────────────────────────
msg_info "Configuring Nginx"
cat <<'NGINXCONF' >/etc/nginx/sites-available/magic-8-ball
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
NGINXCONF
ln -sf /etc/nginx/sites-available/magic-8-ball /etc/nginx/sites-enabled/magic-8-ball
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
systemctl enable nginx -q
systemctl restart nginx
msg_ok "Nginx configured and running"

# ── systemd service ───────────────────────────────────────────────────────────
msg_info "Creating systemd service"
cat <<'SVCEOF' >/etc/systemd/system/magic-8-ball.service
[Unit]
Description=Magic 8 Ball v2 (JEV decision demo)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/magic-8-ball-v2/server
EnvironmentFile=/opt/magic-8-ball-v2/server/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable magic-8-ball -q
systemctl start magic-8-ball
msg_ok "Service created and started"

# ── Verify ────────────────────────────────────────────────────────────────────
sleep 2
if systemctl is-active --quiet magic-8-ball; then
  msg_ok "Backend is running"
else
  msg_error "Backend failed to start — check: journalctl -u magic-8-ball -n 20"
fi

if systemctl is-active --quiet nginx; then
  msg_ok "Nginx is running"
else
  msg_error "Nginx failed to start — check: journalctl -u nginx -n 20"
fi

if curl -sf -o /dev/null http://localhost/; then
  msg_ok "Serving on http://localhost/"
else
  msg_error "http://localhost/ is not responding"
fi

echo ""
echo -e "${GN}  Installation complete!${CL}"
if ! grep -q "^OPENROUTER_API_KEY=sk-or-[A-Za-z0-9]" "$APP_DIR/server/.env" 2>/dev/null; then
  echo -e "${YW}  ⚠  Set your OpenRouter key before real answers:${CL}"
  echo -e "       nano $APP_DIR/server/.env"
  echo -e "       systemctl restart magic-8-ball"
fi
