import 'dotenv/config'

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
