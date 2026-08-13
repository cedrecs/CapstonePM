// Ported from obsidian-pm (MIT, StepanKropachev/obsidian-pm) src/utils.ts.
// DOM- and Obsidian-dependent helpers (setIcon probing, Notice wrappers, svg
// element creation) are omitted; everything here is pure.
import type { Task, StatusConfig, PriorityConfig, TaskPriority } from './types'
import { today, parsePlainDate } from './dates'

export type DueUrgency = 'overdue' | 'near' | 'normal'

export function stringToColor(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash)
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`
}

/** "Mar 28" */
export function formatDateShort(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Mar 28, '26" */
export function formatDateLong(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
}

export function isTerminalStatus(status: string, statuses: StatusConfig[]): boolean {
  const cfg = statuses.find((s) => s.id === status)
  return cfg ? cfg.complete : false
}

export function getDefaultStatusId(statuses: StatusConfig[]): string {
  return statuses.length > 0 ? statuses[0].id : 'todo'
}

export function getDefaultPriorityId(priorities: PriorityConfig[]): string {
  if (priorities.some((p) => p.id === 'medium')) return 'medium'
  return priorities.length > 0 ? priorities[Math.floor(priorities.length / 2)].id : 'medium'
}

export function getCompleteStatusId(statuses: StatusConfig[]): string {
  const found = statuses.find((s) => s.complete)
  return found ? found.id : 'done'
}

export function statusSortOrder(status: string, statuses: StatusConfig[]): number {
  const idx = statuses.findIndex((s) => s.id === status)
  return idx >= 0 ? idx : 999
}

/** Terminal tasks are never urgent. */
export function dueUrgency(task: Task, statuses: StatusConfig[]): DueUrgency {
  const due = parsePlainDate(task.due)
  if (!due || isTerminalStatus(task.status, statuses)) return 'normal'
  const days = today().until(due, { largestUnit: 'day' }).days
  if (days < 0) return 'overdue'
  return days < 3 ? 'near' : 'normal'
}

/** Objects fall back to '' rather than rendering as [object Object]. */
export function stringifyCustomValue(val: unknown): string {
  if (val === undefined || val === null) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (Array.isArray(val)) return val.map((v) => String(v)).join(', ')
  return ''
}

export function truncateTitle(title: string, maxLen = 20): string {
  if (title.length <= maxLen) return title
  return title.slice(0, maxLen - 1) + '…'
}

export function sanitizeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '-')
}

export function getStatusConfig(statuses: StatusConfig[], id: string): StatusConfig | undefined {
  return statuses.find((s) => s.id === id)
}

export function getPriorityConfig(priorities: PriorityConfig[], id: TaskPriority): PriorityConfig | undefined {
  return priorities.find((p) => p.id === id)
}
