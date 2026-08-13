# Raspberry Pi deployment

Target: Pi 4/5 with an **SSD** (not an SD card — vault writes are frequent), 64-bit Raspberry Pi OS, behind a **Cloudflare Tunnel** (no port forwarding, no static IP; TLS terminates at Cloudflare).

```bash
curl -fsSL https://raw.githubusercontent.com/cedrecs/CapstonePM/main/deploy/pi/setup.sh | bash
```

…or clone the repo and run `deploy/pi/setup.sh`. The script installs Node 24 + pnpm, checks out the app to `/opt/capstone-pm`, builds the SPA, installs the `pm-server` systemd unit, and prints the Cloudflare Tunnel steps (the `cloudflared tunnel login` step is interactive and needs your browser).

## Requirements

- A domain with DNS on Cloudflare (the tunnel maps `pm.yourdomain.com` → `localhost:3000`).
- The same Discord credentials as any other environment, in `/opt/capstone-pm/.env`.
- Add `https://pm.yourdomain.com/auth/callback` to the Discord application's OAuth redirect list.

## Git sync = backup (treat as mandatory on Pi)

An SD card or lone SSD is not a backup. Set a per-guild git remote (Settings API or `pm-settings.json` → `git.remote`, e.g. a private GitHub repo per team); the server auto-commits ~30s after the last write and pushes. `POST /api/git/sync` (admin) pulls remote changes in — that is also the Obsidian bridge: clone the same repo into an Obsidian vault.

For pushes to work non-interactively, give the `pm` user credentials for the remote (a GitHub fine-grained PAT in the remote URL, or an SSH deploy key in `/home/pm/.ssh`).

## Operations

```bash
journalctl -u pm-server -f          # logs
sudo systemctl restart pm-server    # deploy after git pull + rebuild
sudo systemctl stop pm-server       # graceful: drains write queue + flushes git
```

Updating: `cd /opt/capstone-pm && sudo -u pm git pull && sudo -u pm pnpm install && sudo -u pm pnpm --filter @pm/client build && sudo systemctl restart pm-server`.
