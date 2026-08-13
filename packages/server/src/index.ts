import { buildApp } from './app'
import { env } from './env'
import { VaultManager } from './vault/VaultManager'
import { attachWebSocket } from './ws'

const vaults = new VaultManager(env.vaultRoot)

const app = buildApp({
  vaults,
  jwtSecret: env.jwtSecret,
  publicUrl: env.publicUrl,
  discordClientId: env.discord.clientId,
  discordClientSecret: env.discord.clientSecret
})

async function main(): Promise<void> {
  env.assertProduction()
  await app.listen({ port: env.port, host: env.host })
  attachWebSocket(app.server, vaults, env.jwtSecret)
  console.log(`[pm] listening on ${env.host}:${env.port} (${env.publicUrl})`)

  // Drain the write queue before exit — required for clean deploys/reboots.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[pm] ${signal} received; draining write queues...`)
    void (async () => {
      try {
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
