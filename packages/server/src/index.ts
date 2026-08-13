import { resolve } from 'node:path'
import { buildApp } from './app'
import { PmBot } from './bot/bot'
import { env } from './env'
import { VaultManager } from './vault/VaultManager'
import { attachWebSocket } from './ws'

const devAuth = process.env.DEV_AUTH === '1'
const jwtSecret = env.jwtSecret || (devAuth ? 'dev-secret-do-not-use' : '')
const vaults = new VaultManager(env.vaultRoot)

const clientDist =
  process.env.CLIENT_DIST ?? resolve(process.cwd(), '..', 'client', 'dist')

const app = buildApp({
  vaults,
  jwtSecret,
  publicUrl: env.publicUrl,
  discordClientId: env.discord.clientId,
  discordClientSecret: env.discord.clientSecret,
  devAuth,
  clientDist
})

async function main(): Promise<void> {
  if (!devAuth) env.assertProduction()
  else console.warn('[pm] DEV_AUTH=1 — Discord login bypass enabled; never use in production')
  await app.listen({ port: env.port, host: env.host })
  attachWebSocket(app.server, vaults, jwtSecret)
  console.log(`[pm] listening on ${env.host}:${env.port} (${env.publicUrl})`)

  let bot: PmBot | null = null
  if (env.discord.botToken && env.discord.clientId) {
    bot = new PmBot({
      vaults,
      token: env.discord.botToken,
      clientId: env.discord.clientId,
      publicUrl: env.publicUrl
    })
    console.log(`[bot] invite the bot to a server: ${bot.inviteUrl()}`)
    bot.start().catch((e) => {
      console.error('[bot] failed to start (server keeps running):', e)
      bot = null
    })
  } else {
    console.log('[bot] DISCORD_BOT_TOKEN not set — bot disabled')
  }

  // Drain the write queue before exit — required for clean deploys/reboots.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[pm] ${signal} received; draining write queues...`)
    void (async () => {
      try {
        if (bot) await bot.stop()
        await app.close()
        await vaults.drainAll()
        console.log('[pm] clean shutdown')
        process.exit(0)
      } catch (e) {
        console.error('[pm] shutdown error', e)
        process.exit(1)
      }
    })()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error('[pm] fatal', e)
  process.exit(1)
})
