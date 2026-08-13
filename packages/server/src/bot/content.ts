// Pure builders for everything the bot posts. No discord.js imports, so the
// formatting logic is unit-testable without a gateway connection.
import type { Project, StatusConfig, Task } from '@pm/shared'
import { flattenTasks, isTerminalStatus, parsePlainDate, Temporal, today } from '@pm/shared'

export interface StatusEmbedData {
  title: string
  color: number
  url: string
  percentComplete: number
  countsLine: string
  overdue: { title: string; due: string; assignees: string[] }[]
  upcomingMilestones: { title: string; due: string }[]
  totalOpen: number
}

function activeTasks(project: Project): Task[] {
  return flattenTasks(project.tasks)
    .map((f) => f.task)
    .filter((t) => !t.archived)
}

export function deepLink(publicUrl: string, guildId: string, projectId: string, taskId?: string): string {
  const base = `${publicUrl}/g/${guildId}/p/${projectId}`
  return taskId ? `${base}/t/${taskId}` : base
}

export function buildStatusEmbedData(
  project: Project,
  statuses: StatusConfig[],
  publicUrl: string,
  guildId: string
): StatusEmbedData {
  const tasks = activeTasks(project)
  const now = today()

  const counts = new Map<string, number>()
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
  const countsLine =
    statuses
      .filter((s) => (counts.get(s.id) ?? 0) > 0)
      .map((s) => `${s.label}: **${counts.get(s.id)}**`)
      .join(' · ') || 'No tasks yet'

  const done = tasks.filter((t) => isTerminalStatus(t.status, statuses)).length
  const percentComplete = tasks.length ? Math.round((done / tasks.length) * 100) : 0

  const overdue = tasks
    .filter((t) => {
      const due = parsePlainDate(t.due)
      return due && Temporal.PlainDate.compare(due, now) < 0 && !isTerminalStatus(t.status, statuses)
    })
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 5)
    .map((t) => ({ title: t.title, due: t.due, assignees: t.assignees }))

  const upcomingMilestones = tasks
    .filter((t) => {
      if (t.type !== 'milestone' || isTerminalStatus(t.status, statuses)) return false
      const due = parsePlainDate(t.due)
      return due && Temporal.PlainDate.compare(due, now) >= 0
    })
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 3)
    .map((t) => ({ title: t.title, due: t.due }))

  return {
    title: `${project.icon} ${project.title}`,
    color: parseInt(project.color.replace('#', ''), 16) || 0x8b72be,
    url: deepLink(publicUrl, guildId, project.id),
    percentComplete,
    countsLine,
    overdue,
    upcomingMilestones,
    totalOpen: tasks.length - done
  }
}

export interface DigestData {
  projectTitle: string
  completedLastWeek: string[]
  dueThisWeek: { title: string; due: string; assignees: string[] }[]
  overdue: { title: string; due: string; assignees: string[] }[]
  blocked: string[]
  hoursByMember: Record<string, number>
}

/** Weekly digest: completed last 7 days, due next 7 days, overdue, blocked, hours. */
export function buildDigestData(project: Project, statuses: StatusConfig[]): DigestData {
  const tasks = activeTasks(project)
  const now = today()
  const weekAgo = now.subtract({ days: 7 })
  const weekOut = now.add({ days: 7 })

  const completedLastWeek = tasks
    .filter((t) => {
      const c = parsePlainDate(t.completed)
      return c && Temporal.PlainDate.compare(c, weekAgo) >= 0 && Temporal.PlainDate.compare(c, now) <= 0
    })
    .map((t) => t.title)

  const dueThisWeek = tasks
    .filter((t) => {
      if (isTerminalStatus(t.status, statuses)) return false
      const due = parsePlainDate(t.due)
      return due && Temporal.PlainDate.compare(due, now) >= 0 && Temporal.PlainDate.compare(due, weekOut) <= 0
    })
    .sort((a, b) => a.due.localeCompare(b.due))
    .map((t) => ({ title: t.title, due: t.due, assignees: t.assignees }))

  const overdue = tasks
    .filter((t) => {
      const due = parsePlainDate(t.due)
      return due && Temporal.PlainDate.compare(due, now) < 0 && !isTerminalStatus(t.status, statuses)
    })
    .sort((a, b) => a.due.localeCompare(b.due))
    .map((t) => ({ title: t.title, due: t.due, assignees: t.assignees }))

  const blocked = tasks.filter((t) => t.status === 'blocked').map((t) => t.title)

  const hoursByMember: Record<string, number> = {}
  for (const t of flattenTasks(project.tasks).map((f) => f.task)) {
    for (const log of t.timeLogs ?? []) {
      const d = parsePlainDate(log.date)
      if (!d || Temporal.PlainDate.compare(d, weekAgo) < 0 || Temporal.PlainDate.compare(d, now) > 0) continue
      for (const member of t.assignees.length ? t.assignees : ['(unassigned)']) {
        hoursByMember[member] = (hoursByMember[member] ?? 0) + log.hours / (t.assignees.length || 1)
      }
    }
  }

  return { projectTitle: project.title, completedLastWeek, dueThisWeek, overdue, blocked, hoursByMember }
}

export interface ReminderCandidate {
  task: Task
  projectId: string
}

/** Open tasks whose due date is within leadDays (or already today), not yet reminded today. */
export function collectDueReminders(
  project: Project,
  statuses: StatusConfig[],
  leadDays: number,
  remindedAt: Record<string, string>
): ReminderCandidate[] {
  const now = today()
  const horizon = now.add({ days: leadDays })
  const out: ReminderCandidate[] = []
  for (const t of activeTasks(project)) {
    if (isTerminalStatus(t.status, statuses)) continue
    const due = parsePlainDate(t.due)
    if (!due) continue
    if (Temporal.PlainDate.compare(due, horizon) > 0) continue
    if (remindedAt[t.id] === now.toString()) continue
    out.push({ task: t, projectId: project.id })
  }
  return out
}

/** "in 3 days" / "today" / "2 days overdue" */
export function duePhrase(due: string): string {
  const d = parsePlainDate(due)
  if (!d) return ''
  const days = today().until(d, { largestUnit: 'day' }).days
  if (days < 0) return `**${-days} day${days === -1 ? '' : 's'} overdue**`
  if (days === 0) return '**due today**'
  if (days === 1) return 'due tomorrow'
  return `due in ${days} days`
}
