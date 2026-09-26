#!/usr/bin/env bash
# ==============================================================================
# Magic 8 Ball v2 — Container Upgrade Script
# Runs INSIDE the LXC container. Typical invocation from the Proxmox host:
#
#   pct exec <CTID> -- bash < <(curl -fsSL \
#     https://raw.githubusercontent.com/Grant-Visser/magic-8-ball-v2/main/proxmox/magic-8-ball-upgrade.sh)
# ==============================================================================
set -euo pipefail

YW="\033[33m" GN="\033[1;92m" RD="\033[01;31m" CL="\033[m"
CM="${GN}✓${CL}" CROSS="${RD}✗${CL}" TAB="  "

msg_info()  { echo -e "${TAB}${YW}○${CL} ${1}..."; }
msg_ok()    { echo -e "${TAB}${CM} ${1}"; }
msg_error() { echo -e "${TAB}${CROSS} ${RD}${1}${CL}"; exit 1; }

APP_DIR="/opt/magic-8-ball-v2"
SERVICE="magic-8-ball"
[[ -d "$APP_DIR" ]] || msg_error "$APP_DIR not found — run the installer first"

# ── Pull latest ───────────────────────────────────────────────────────────────
msg_info "Pulling latest code"
cd "$APP_DIR"
OLD_COMMIT=$(git rev-parse --short HEAD)
git pull --ff-only -q
NEW_COMMIT=$(git rev-parse --short HEAD)
if [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  msg_ok "Already up to date ($NEW_COMMIT)"
else
  msg_ok "Updated $OLD_COMMIT -> $NEW_COMMIT"
fi

# ── Server deps ───────────────────────────────────────────────────────────────
msg_info "Syncing backend dependencies"
cd "$APP_DIR/server"
npm ci --silent
msg_ok "Backend dependencies synced"

# ── Frontend rebuild ──────────────────────────────────────────────────────────
msg_info "Rebuilding frontend"
cd "$APP_DIR/client"
npm ci --silent
npm run build >/dev/null 2>&1
msg_ok "Frontend rebuilt"

# ── Restore env if git touched it (it shouldn't — .env is untracked) ──────────
if [[ ! -f "$APP_DIR/server/.env" ]]; then
  cp "$APP_DIR/server/.env.example" "$APP_DIR/server/.env"
  chmod 600 "$APP_DIR/server/.env"
  echo -e "${YW}${TAB}⚠ server/.env was missing — recreated from example, add your key!${CL}"
fi

# ── Restart ───────────────────────────────────────────────────────────────────
msg_info "Restarting service"
systemctl restart "$SERVICE"
sleep 2

# ── Verify ────────────────────────────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE"; then
  msg_ok "$SERVICE is running"
else
  msg_error "$SERVICE failed to start — check: journalctl -u $SERVICE -n 50"
fi

if curl -sf -o /dev/null http://localhost/; then
  msg_ok "Serving on http://localhost/"
else
  msg_error "http://localhost/ is not responding"
fi

echo ""
echo -e "${GN}  Upgrade complete — now on ${NEW_COMMIT}${CL}"
