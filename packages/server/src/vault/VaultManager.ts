import { EventEmitter } from 'node:events'
import type { VaultChange } from './GuildVault'
import { GuildVault } from './GuildVault'

/**
 * Lazily opens one GuildVault per guild; concurrent opens collapse. Re-emits
 * every vault's 'change' events so the WS hub and the bot can subscribe once.
 */
export class VaultManager extends EventEmitter {
  private vaults = new Map<string, Promise<GuildVault>>()

  constructor(private vaultRoot: string) {
    super()
  }

  get(guildId: string): Promise<GuildVault> {
    let loading = this.vaults.get(guildId)
    if (!loading) {
      loading = GuildVault.open(guildId, this.vaultRoot).then((vault) => {
        vault.on('change', (change: VaultChange) => this.emit('change', change))
        return vault
      })
      this.vaults.set(guildId, loading)
      loading.catch(() => this.vaults.delete(guildId))
    }
    return loading
  }

  /** Vaults currently open (loaded), for iteration by schedulers. */
  async openVaults(): Promise<GuildVault[]> {
    const out: GuildVault[] = []
    for (const loading of this.vaults.values()) {
      try {
        out.push(await loading)
      } catch {
        // failed open; skip
      }
    }
    return out
  }

  /** Drain write queues and flush pending git commits; called on graceful shutdown. */
  async drainAll(): Promise<void> {
    for (const vault of await this.openVaults()) {
      await vault.shutdown()
    }
  }
}
