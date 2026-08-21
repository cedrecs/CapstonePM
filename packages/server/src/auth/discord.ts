import type { AppRole, GuildSettings } from '../vault/sidecar'

const DISCORD_API = 'https://discord.com/api/v10'
const OAUTH_SCOPES = 'identify guilds guilds.members.read'

export interface DiscordUser {
  id: string
  username: string
  global_name?: string | null
}

export interface DiscordMember {
  roles: string[]
  nick?: string | null
}

/** The subset of `/users/@me/guilds` needed to decide bootstrap admin access. */
export interface DiscordGuildSummary {
  owner: boolean
  /** Decimal permission bitfield, as a string (Discord returns it as one). */
  permissions: string
}

/** Injectable so tests never hit Discord. */
export interface DiscordOAuthClient {
  authorizeUrl(clientId: string, redirectUri: string, state: string): string
  exchangeCode(code: string, redirectUri: string, clientId: string, clientSecret: string): Promise<string>
  fetchUser(accessToken: string): Promise<DiscordUser>
  fetchMember(accessToken: string, guildId: string): Promise<DiscordMember | null>
  /** Null if the user isn't in that guild (shouldn't happen once fetchMember succeeded). */
  fetchGuildSummary(accessToken: string, guildId: string): Promise<DiscordGuildSummary | null>
}

export const discordOAuth: DiscordOAuthClient = {
  authorizeUrl(clientId, redirectUri, state) {
    // No `prompt` param: this is the primary login link, so Discord must be
    // free to show its login/consent UI on first use. `prompt=none` forces a
    // silent-only exchange that errors out unless this exact device/session
    // already carries a valid Discord session AND prior consent — it broke
    // login on any browser without that pre-existing state.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPES,
      state
    })
    return `https://discord.com/oauth2/authorize?${params}`
  },

  async exchangeCode(code, redirectUri, clientId, clientSecret) {
    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret
      })
    })
    if (!res.ok) throw new Error(`token exchange failed: ${res.status}`)
    const data = (await res.json()) as { access_token: string }
    return data.access_token
  },

  async fetchUser(accessToken) {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!res.ok) throw new Error(`fetch user failed: ${res.status}`)
    return (await res.json()) as DiscordUser
  },

  async fetchMember(accessToken, guildId) {
    const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (res.status === 404) return null // not a member of that guild
    if (!res.ok) throw new Error(`fetch member failed: ${res.status}`)
    return (await res.json()) as DiscordMember
  },

  async fetchGuildSummary(accessToken, guildId) {
    // No single-guild endpoint carries owner/permissions for the calling user;
    // they only appear in the full `/users/@me/guilds` listing.
    const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!res.ok) throw new Error(`fetch guilds failed: ${res.status}`)
    const guilds = (await res.json()) as { id: string; owner: boolean; permissions: string }[]
    const match = guilds.find((g) => g.id === guildId)
    return match ? { owner: match.owner, permissions: match.permissions } : null
  }
}

const PERMISSION_ADMINISTRATOR = 0x8n
const PERMISSION_MANAGE_GUILD = 0x20n

/**
 * Whether this Discord member effectively runs the server — its owner, or
 * holds Administrator/Manage Server — independent of any role mapping we've
 * configured. Used only to bootstrap the very first admin of a guild.
 */
export function hasGuildManageAccess(summary: DiscordGuildSummary): boolean {
  if (summary.owner) return true
  let bits: bigint
  try {
    bits = BigInt(summary.permissions)
  } catch {
    return false
  }
  return (bits & PERMISSION_ADMINISTRATOR) !== 0n || (bits & PERMISSION_MANAGE_GUILD) !== 0n
}

const ROLE_RANK: Record<AppRole, number> = { admin: 3, member: 2, advisor: 1, sponsor: 0 }

/**
 * Highest-privilege app role granted by the member's Discord roles. A guild
 * member with no mapped role defaults to 'member' — capstone teammates should
 * work out of the box; Advisor/Sponsor demotion is an explicit mapping.
 */
export function resolveAppRole(memberRoleIds: string[], settings: GuildSettings): AppRole {
  let best: AppRole | null = null
  for (const roleId of memberRoleIds) {
    const mapped = settings.discord.roleMap[roleId]
    if (mapped && (best === null || ROLE_RANK[mapped] > ROLE_RANK[best])) best = mapped
  }
  return best ?? 'member'
}

export function canWriteTasks(role: AppRole): boolean {
  return role === 'admin' || role === 'member'
}

export function isAdmin(role: AppRole): boolean {
  return role === 'admin'
}
