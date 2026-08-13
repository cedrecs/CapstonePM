import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js'
import type { Project, Task } from '@pm/shared'
import { flattenTasks, isTerminalStatus } from '@pm/shared'
import { resolveAppRole, canWriteTasks } from '../auth/discord'
import type { GuildVault } from '../vault/GuildVault'
import type { VaultManager } from '../vault/VaultManager'
import {
  buildDigestData,
  buildStatusEmbedData,
  collectDueReminders,
  deepLink,
  duePhrase
} from './content'

export interface BotDeps {
  vaults: VaultManager
  token: string
  clientId: string
  publicUrl: string
}

const EMBED_DEBOUNCE_MS = 30_000
const REMINDER_INTERVAL_MS = 15 * 60 * 1000

export function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('pm')
      .setDescription('Project management')
      .addSubcommand((s) =>
        s
          .setName('dashboard')
          .setDescription('Post (or refresh) the live status embed for a project in this channel')
          .addStringOption((o) =>
            o.setName('project').setDescription('Project name').setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('task')
          .setDescription('Look up a task')
          .addStringOption((o) => o.setName('search').setDescription('Title search').setRequired(true))
      )
      .addSubcommand((s) => s.setName('my-tasks').setDescription('Your open tasks'))
      .addSubcommand((s) =>
        s
          .setName('due')
          .setDescription('What is due soon')
          .addStringOption((o) =>
            o
              .setName('period')
              .setDescription('Time window')
              .addChoices({ name: 'today', value: 'today' }, { name: 'week', value: 'week' })
          )
      )
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Quick-add a task')
          .addStringOption((o) => o.setName('title').setDescription('Task title').setRequired(true))
          .addStringOption((o) =>
            o.setName('project').setDescription('Project (defaults to the one bound to this channel)').setAutocomplete(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('report')
          .setDescription('Post this week’s digest for the project bound to this channel')
          .addStringOption((o) =>
            o.setName('project').setDescription('Project (defaults to the bound one)').setAutocomplete(true)
          )
      )
      .toJSON()
  ]
}

export class PmBot {
  readonly client: Client
  private embedTimers = new Map<string, NodeJS.Timeout>()
  private reminderTimer: NodeJS.Timeout | null = null

  constructor(private deps: BotDeps) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] })
  }

  inviteUrl(): string {
    // Permissions: View Channels, Send Messages, Embed Links, Manage Messages (pinning).
    const perms = '27648'
    return `https://discord.com/oauth2/authorize?client_id=${this.deps.clientId}&scope=bot%20applications.commands&permissions=${perms}`
  }

  async start(): Promise<void> {
    this.client.on('clientReady', () => {
      console.log(`[bot] logged in as ${this.client.user?.tag}`)
      void this.registerCommandsEverywhere()
      // Open the vault of every guild the bot lives in so reminders cover them.
      for (const [guildId] of this.client.guilds.cache) void this.deps.vaults.get(guildId)
    })
    this.client.on('guildCreate', (guild) => {
      void this.registerCommands(guild.id)
      void this.deps.vaults.get(guild.id)
    })
    this.client.on('interactionCreate', (interaction) => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'pm') {
        this.handleCommand(interaction).catch((e) => {
          console.error('[bot] command error', e)
          const msg = { content: 'Something went wrong.', ephemeral: true }
          void (interaction.deferred || interaction.replied
            ? interaction.followUp(msg)
            : interaction.reply(msg))
        })
      } else if (interaction.isAutocomplete() && interaction.commandName === 'pm') {
        void this.handleAutocomplete(interaction.guildId, interaction).catch(() => {})
      }
    })

    // Vault changes drive debounced embed refreshes.
    this.deps.vaults.on('change', (change: { guildId: string; projectId?: string }) => {
      if (change.projectId) this.scheduleEmbedUpdate(change.guildId, change.projectId)
    })

    this.reminderTimer = setInterval(() => {
      this.runReminderPass().catch((e) => console.error('[bot] reminder pass failed', e))
    }, REMINDER_INTERVAL_MS)

    await this.client.login(this.deps.token)
  }

  async stop(): Promise<void> {
    if (this.reminderTimer) clearInterval(this.reminderTimer)
    for (const timer of this.embedTimers.values()) clearTimeout(timer)
    await this.client.destroy()
  }

  private async registerCommandsEverywhere(): Promise<void> {
    for (const [guildId] of this.client.guilds.cache) {
      await this.registerCommands(guildId)
    }
  }

  /** Per-guild registration: instant, unlike global's up-to-an-hour propagation. */
  private async registerCommands(guildId: string): Promise<void> {
    const rest = new REST().setToken(this.deps.token)
    try {
      await rest.put(Routes.applicationGuildCommands(this.deps.clientId, guildId), {
        body: buildCommands()
      })
    } catch (e) {
      console.error(`[bot] slash registration failed for guild ${guildId}`, e)
    }
  }

  // ---------- live status embed ----------

  private scheduleEmbedUpdate(guildId: string, projectId: string): void {
    const key = `${guildId}:${projectId}`
    if (this.embedTimers.has(key)) return // already queued; coalesce
    this.embedTimers.set(
      key,
      setTimeout(() => {
        this.embedTimers.delete(key)
        this.updateEmbed(guildId, projectId).catch((e) => console.error('[bot] embed update failed', e))
      }, EMBED_DEBOUNCE_MS)
    )
  }

  private statusEmbed(vault: GuildVault, project: Project): EmbedBuilder {
    const data = buildStatusEmbedData(
      project,
      vault.configFor(project).statuses,
      this.deps.publicUrl,
      vault.guildId
    )
    const embed = new EmbedBuilder()
      .setTitle(data.title)
      .setURL(data.url)
      .setColor(data.color)
      .setDescription(`**${data.percentComplete}% complete** · ${data.totalOpen} open\n${data.countsLine}`)
      .setTimestamp(new Date())
      .setFooter({ text: 'PM for Discord · click the title to open' })
    if (data.overdue.length) {
      embed.addFields({
        name: '⚠️ Overdue',
        value: data.overdue
          .map((t) => `• ${t.title} (${duePhrase(t.due)})${t.assignees.length ? ` — ${t.assignees.join(', ')}` : ''}`)
          .join('\n')
      })
    }
    if (data.upcomingMilestones.length) {
      embed.addFields({
        name: '◆ Upcoming milestones',
        value: data.upcomingMilestones.map((m) => `• ${m.title} — ${m.due}`).join('\n')
      })
    }
    return embed
  }

  private async updateEmbed(guildId: string, projectId: string): Promise<void> {
    const vault = await this.deps.vaults.get(guildId)
    const binding = vault.settings.discord.channelBindings[projectId]
    if (!binding) return
    const project = vault.projects.get(projectId)
    if (!project) return
    const channel = await this.client.channels.fetch(binding.channelId).catch(() => null)
    if (!channel || channel.type !== ChannelType.GuildText) return
    const embed = this.statusEmbed(vault, project)

    if (binding.messageId) {
      const msg = await channel.messages.fetch(binding.messageId).catch(() => null)
      if (msg) {
        await msg.edit({ embeds: [embed] })
        return
      }
    }
    const msg = await channel.send({ embeds: [embed] })
    await vault.updateSettings({
      discord: {
        ...vault.settings.discord,
        channelBindings: {
          ...vault.settings.discord.channelBindings,
          [projectId]: { channelId: binding.channelId, messageId: msg.id }
        }
      }
    })
  }

  // ---------- reminders ----------

  private async runReminderPass(): Promise<void> {
    for (const vault of await this.deps.vaults.openVaults()) {
      const pm = vault.settings.pm
      if (!pm.notificationsEnabled) continue
      const reminded = vault.settings.discord.remindedAt ?? {}
      const mentionFor = this.buildMentionLookup(vault)
      const newlyReminded: Record<string, string> = {}

      for (const project of vault.projects.values()) {
        const binding = vault.settings.discord.channelBindings[project.id]
        if (!binding) continue
        const statuses = vault.configFor(project).statuses
        const due = collectDueReminders(project, statuses, pm.notificationLeadDays, reminded)
        if (!due.length) continue
        const channel = await this.client.channels.fetch(binding.channelId).catch(() => null)
        if (!channel || channel.type !== ChannelType.GuildText) continue

        const lines = due.map(({ task }) => {
          const mentions = task.assignees.map((a) => mentionFor(a)).join(' ')
          const link = deepLink(this.deps.publicUrl, vault.guildId, project.id, task.id)
          return `• [${task.title}](${link}) ${duePhrase(task.due)}${mentions ? ` ${mentions}` : ''}`
        })
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle(`⏰ Due soon — ${project.title}`)
              .setColor(0xb8a06b)
              .setDescription(lines.join('\n'))
          ]
        })
        const todayStr = new Date().toISOString().slice(0, 10)
        for (const { task } of due) newlyReminded[task.id] = todayStr
      }

      if (Object.keys(newlyReminded).length) {
        await vault.updateSettings({
          discord: {
            ...vault.settings.discord,
            remindedAt: { ...reminded, ...newlyReminded }
          }
        })
      }
    }
  }

  /** assignee name -> <@userId> mention when mapped, else the bare name. */
  private buildMentionLookup(vault: GuildVault): (assignee: string) => string {
    const byName = new Map<string, string>()
    for (const [userId, name] of Object.entries(vault.settings.discord.userMap)) {
      byName.set(name.toLowerCase(), userId)
    }
    return (assignee: string) => {
      const userId = byName.get(assignee.toLowerCase())
      return userId ? `<@${userId}>` : assignee
    }
  }

  // ---------- slash commands ----------

  private async handleAutocomplete(
    guildId: string | null,
    interaction: { respond: (choices: { name: string; value: string }[]) => Promise<void>; options: { getFocused: () => string } }
  ): Promise<void> {
    if (!guildId) return interaction.respond([])
    const vault = await this.deps.vaults.get(guildId)
    const q = interaction.options.getFocused().toLowerCase()
    const choices = [...vault.projects.values()]
      .filter((p) => p.title.toLowerCase().includes(q))
      .slice(0, 25)
      .map((p) => ({ name: p.title, value: p.id }))
    await interaction.respond(choices)
  }

  private resolveProject(vault: GuildVault, interaction: ChatInputCommandInteraction): Project | null {
    const explicit = interaction.options.getString('project')
    if (explicit) {
      return (
        vault.projects.get(explicit) ??
        [...vault.projects.values()].find((p) => p.title.toLowerCase() === explicit.toLowerCase()) ??
        null
      )
    }
    for (const [pid, binding] of Object.entries(vault.settings.discord.channelBindings)) {
      if (binding.channelId === interaction.channelId) return vault.projects.get(pid) ?? null
    }
    // A single-project guild needs no binding to be unambiguous.
    if (vault.projects.size === 1) return [...vault.projects.values()][0]
    return null
  }

  private memberRole(vault: GuildVault, interaction: ChatInputCommandInteraction) {
    const roles = interaction.member && 'roles' in interaction.member
      ? Array.isArray(interaction.member.roles)
        ? interaction.member.roles
        : [...interaction.member.roles.cache.keys()]
      : []
    return resolveAppRole(roles, vault.settings)
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Use this in a server.', ephemeral: true })
      return
    }
    const vault = await this.deps.vaults.get(interaction.guildId)
    const sub = interaction.options.getSubcommand()

    if (sub === 'dashboard') {
      const project = this.resolveProject(vault, interaction)
      if (!project) {
        await interaction.reply({ content: 'Project not found.', ephemeral: true })
        return
      }
      await vault.updateSettings({
        discord: {
          ...vault.settings.discord,
          channelBindings: {
            ...vault.settings.discord.channelBindings,
            [project.id]: { channelId: interaction.channelId }
          }
        }
      })
      const embed = this.statusEmbed(vault, project)
      const reply = await interaction.reply({ embeds: [embed], withResponse: true })
      const messageId = reply.resource?.message?.id
      if (messageId) {
        await vault.updateSettings({
          discord: {
            ...vault.settings.discord,
            channelBindings: {
              ...vault.settings.discord.channelBindings,
              [project.id]: { channelId: interaction.channelId, messageId }
            }
          }
        })
      }
      return
    }

    if (sub === 'task') {
      const q = interaction.options.getString('search', true).toLowerCase()
      for (const project of vault.projects.values()) {
        const hit = flattenTasks(project.tasks)
          .map((f) => f.task)
          .find((t) => !t.archived && t.title.toLowerCase().includes(q))
        if (hit) {
          const statuses = vault.configFor(project).statuses
          const st = statuses.find((s) => s.id === hit.status)
          const embed = new EmbedBuilder()
            .setTitle(`${hit.type === 'milestone' ? '◆ ' : ''}${hit.title}`)
            .setURL(deepLink(this.deps.publicUrl, vault.guildId, project.id, hit.id))
            .setColor(parseInt((st?.color ?? '#8a94a0').replace('#', ''), 16))
            .addFields(
              { name: 'Status', value: st?.label ?? hit.status, inline: true },
              { name: 'Priority', value: hit.priority, inline: true },
              { name: 'Due', value: hit.due || '—', inline: true },
              { name: 'Assignees', value: hit.assignees.join(', ') || '—', inline: true },
              { name: 'Progress', value: `${hit.progress}%`, inline: true },
              { name: 'Project', value: project.title, inline: true }
            )
          await interaction.reply({ embeds: [embed] })
          return
        }
      }
      await interaction.reply({ content: `No task matching “${q}”.`, ephemeral: true })
      return
    }

    if (sub === 'my-tasks') {
      const name =
        vault.settings.discord.userMap[interaction.user.id] ??
        (interaction.member && 'displayName' in interaction.member
          ? (interaction.member.displayName as string)
          : interaction.user.username)
      const lines: string[] = []
      for (const project of vault.projects.values()) {
        const statuses = vault.configFor(project).statuses
        for (const t of flattenTasks(project.tasks).map((f) => f.task)) {
          if (t.archived || isTerminalStatus(t.status, statuses)) continue
          if (!t.assignees.some((a) => a.toLowerCase() === name.toLowerCase())) continue
          const link = deepLink(this.deps.publicUrl, vault.guildId, project.id, t.id)
          lines.push(`• [${t.title}](${link})${t.due ? ` — ${duePhrase(t.due)}` : ''}`)
        }
      }
      await interaction.reply({
        content: lines.length ? `Open tasks for **${name}**:\n${lines.join('\n')}` : `Nothing open for **${name}** 🎉`,
        ephemeral: true
      })
      return
    }

    if (sub === 'due') {
      const period = interaction.options.getString('period') ?? 'week'
      const horizon = period === 'today' ? 0 : 7
      const lines: string[] = []
      for (const project of vault.projects.values()) {
        const statuses = vault.configFor(project).statuses
        for (const { task } of collectDueReminders(project, statuses, horizon, {})) {
          const link = deepLink(this.deps.publicUrl, vault.guildId, project.id, task.id)
          lines.push(`• [${task.title}](${link}) ${duePhrase(task.due)} (${project.title})`)
        }
      }
      await interaction.reply({
        content: lines.length ? `Due ${period === 'today' ? 'today or overdue' : 'this week'}:\n${lines.join('\n')}` : 'Nothing due. 🎉',
        ephemeral: true
      })
      return
    }

    if (sub === 'add') {
      const role = this.memberRole(vault, interaction)
      if (!canWriteTasks(role)) {
        await interaction.reply({ content: 'Your role is read-only.', ephemeral: true })
        return
      }
      const project = this.resolveProject(vault, interaction)
      if (!project) {
        await interaction.reply({
          content: 'No project bound to this channel — pass the project option or run /pm dashboard first.',
          ephemeral: true
        })
        return
      }
      const title = interaction.options.getString('title', true)
      const { task } = await vault.insertTask(project.id, { title })
      await interaction.reply(
        `Added **[${task.title}](${deepLink(this.deps.publicUrl, vault.guildId, project.id, task.id)})** to ${project.title}.`
      )
      return
    }

    if (sub === 'report') {
      const project = this.resolveProject(vault, interaction)
      if (!project) {
        await interaction.reply({ content: 'Project not found.', ephemeral: true })
        return
      }
      const digest = buildDigestData(project, vault.configFor(project).statuses)
      const fmtList = (items: string[]): string => (items.length ? items.map((i) => `• ${i}`).join('\n') : '_none_')
      const embed = new EmbedBuilder()
        .setTitle(`📊 Weekly digest — ${digest.projectTitle}`)
        .setURL(deepLink(this.deps.publicUrl, vault.guildId, project.id))
        .setColor(0x79b58d)
        .addFields(
          { name: '✅ Completed last week', value: fmtList(digest.completedLastWeek) },
          {
            name: '📅 Due this week',
            value: digest.dueThisWeek.length
              ? digest.dueThisWeek.map((t) => `• ${t.title} — ${t.due}`).join('\n')
              : '_none_'
          },
          {
            name: '⚠️ Overdue',
            value: digest.overdue.length
              ? digest.overdue.map((t) => `• ${t.title} (${duePhrase(t.due)})`).join('\n')
              : '_none_'
          },
          { name: '🚫 Blocked', value: fmtList(digest.blocked) },
          {
            name: '⏱️ Hours logged (7d)',
            value:
              Object.entries(digest.hoursByMember)
                .map(([m, h]) => `• ${m}: ${h.toFixed(1)}h`)
                .join('\n') || '_none_'
          }
        )
      await interaction.reply({ embeds: [embed] })
      return
    }
  }
}

/** Task type re-export so tests can build fixtures without importing discord.js. */
export type { Task }
