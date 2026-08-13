import { resolve } from 'node:path'
import { config } from 'dotenv'

// Load the nearest .env: package cwd first, then the repo root (dev runs
// launch from packages/server; production provides real env vars instead).
config({ path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')], quiet: true })

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

/** All deployment-specific knobs. Pi vs Render differ only in these values. */
export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  vaultRoot: process.env.VAULT_ROOT ?? './data/vaults',
  /**
   * Ephemeral-disk mode (Render free tier): a git remote holding the whole
   * vault root. Restored on boot; every write commits+pushes on a short
   * debounce. The remote, not the disk, is the durable store.
   */
  vaultSyncRemote: process.env.VAULT_SYNC_REMOTE || undefined,
  vaultSyncDebounceMs: Number(process.env.VAULT_SYNC_DEBOUNCE_MS ?? 10_000),
  jwtSecret: process.env.JWT_SECRET ?? '',
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
    botToken: process.env.DISCORD_BOT_TOKEN ?? ''
  },
  /** Throw early in production when a secret is missing; tests provide their own. */
  assertProduction(): void {
    required('JWT_SECRET')
    required('DISCORD_CLIENT_ID')
    required('DISCORD_CLIENT_SECRET')
    required('DISCORD_BOT_TOKEN')
  }
}
