#!/usr/bin/env bash
# PM for Discord — Raspberry Pi setup (Debian/Raspberry Pi OS, 64-bit).
# Run as a sudo-capable user. Re-runnable; each step is idempotent.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/cedrecs/CapstonePM.git}"
APP_DIR=/opt/capstone-pm

echo "== 1/6 System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl

echo "== 2/6 Node 24 (NodeSource) + pnpm"
if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
sudo corepack enable || sudo npm install -g pnpm

echo "== 3/6 Service user + checkout"
sudo useradd -r -m -d /home/pm pm 2>/dev/null || true
if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo git clone "$REPO_URL" "$APP_DIR"
fi
sudo chown -R pm:pm "$APP_DIR"

echo "== 4/6 Install + build"
sudo -u pm bash -c "cd $APP_DIR && pnpm install --frozen-lockfile && pnpm --filter @pm/client build"

echo "== 5/6 Environment"
if [[ ! -f "$APP_DIR/.env" ]]; then
  sudo -u pm cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "!! Edit $APP_DIR/.env now: set PORT, PUBLIC_URL, VAULT_ROOT, JWT_SECRET, DISCORD_*"
fi

echo "== 6/6 systemd unit"
sudo cp "$APP_DIR/deploy/pi/pm-server.service" /etc/systemd/system/pm-server.service
sudo systemctl daemon-reload
sudo systemctl enable pm-server

cat <<'EOF'

Done. Next steps:
  1. sudo nano /opt/capstone-pm/.env      # fill in secrets; VAULT_ROOT=/opt/capstone-pm/data/vaults
  2. sudo systemctl start pm-server && journalctl -u pm-server -f
  3. Cloudflare Tunnel (one-time):
       curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cf.deb
       sudo dpkg -i /tmp/cf.deb
       cloudflared tunnel login                    # opens a browser auth
       cloudflared tunnel create pm
       cloudflared tunnel route dns pm pm.yourdomain.com
       # /etc/cloudflared/config.yml:
       #   tunnel: <tunnel-id>
       #   credentials-file: /root/.cloudflared/<tunnel-id>.json
       #   ingress:
       #     - hostname: pm.yourdomain.com
       #       service: http://localhost:3000
       #     - service: http_status:404
       sudo cloudflared service install
  4. Set PUBLIC_URL=https://pm.yourdomain.com in .env, restart pm-server,
     and add that /auth/callback URL in the Discord developer portal.
EOF
