import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PMSettings } from '@pm/shared'
import { DEFAULT_SETTINGS } from '@pm/shared'
import { atomicWrite } from './fsAtomic'

export type AppRole = 'admin' | 'member' | 'advisor' | 'sponsor'

/**
 * Guild-level state the reference plugin keeps in its data.json, plus the
 * Discord-specific maps this port adds. Lives at the vault root as
 * pm-settings.json; Obsidian ignores it.
 */
export interface GuildSettings {
  version: 1
  /** Global PM settings (statuses, priorities, scheduling flags, ...). */
  pm: PMSettings
  discord: {
    /** Discord role id -> app role. Checked in descending privilege order. */
    roleMap: Record<string, AppRole>
    /** Discord user id -> assignee name as it appears in task frontmatter. */
    userMap: Record<string, string>
    /** Project id -> bound channel + the live embed message to keep editing. */
    channelBindings: Record<string, ChannelBinding>
    /** Task id -> last date a due reminder was posted, so restarts don't re-ping. */
    remindedAt?: Record<string, string>
  }
}

export interface ChannelBinding {
  channelId: string
  messageId?: string
}

const SIDECAR_FILE = 'pm-settings.json'

export function defaultGuildSettings(): GuildSettings {
  return {
    version: 1,
    pm: structuredClone(DEFAULT_SETTINGS),
    discord: { roleMap: {}, userMap: {}, channelBindings: {} }
  }
}

export async function loadGuildSettings(guildRoot: string): Promise<GuildSettings> {
  try {
    const raw = await fs.readFile(join(guildRoot, SIDECAR_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<GuildSettings>
    const base = defaultGuildSettings()
    return {
      version: 1,
      pm: { ...base.pm, ...(parsed.pm ?? {}) },
      discord: { ...base.discord, ...(parsed.discord ?? {}) }
    }
  } catch {
    return defaultGuildSettings()
  }
}

export async function saveGuildSettings(guildRoot: string, settings: GuildSettings): Promise<void> {
  await atomicWrite(join(guildRoot, SIDECAR_FILE), JSON.stringify(settings, null, 2) + '\n')
}
