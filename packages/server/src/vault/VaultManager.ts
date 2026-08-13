import { GuildVault } from './GuildVault'

/** Lazily opens one GuildVault per guild; concurrent opens collapse. */
export class VaultManager {
  private vaults = new Map<string, Promise<GuildVault>>()

  constructor(private vaultRoot: string) {}

  get(guildId: string): Promise<GuildVault> {
    let loading = this.vaults.get(guildId)
    if (!loading) {
      loading = GuildVault.open(guildId, this.vaultRoot)
      this.vaults.set(guildId, loading)
      loading.catch(() => this.vaults.delete(guildId))
    }
    return loading
  }

  /** Drain every open vault's write queue; called on graceful shutdown. */
  async drainAll(): Promise<void> {
    for (const loading of this.vaults.values()) {
      try {
        const vault = await loading
        await vault.drain()
      } catch {
        // a vault that failed to open has nothing to drain
      }
    }
  }
}
