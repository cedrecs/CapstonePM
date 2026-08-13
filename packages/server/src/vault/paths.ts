// Vault-internal paths always use forward slashes (they are Obsidian vault
// paths); they are joined onto the guild root only at the fs boundary.
import { join } from 'node:path'
import type { Project, Task } from '@pm/shared'
import { taskFilePath } from '@pm/shared'

/** Obsidian's normalizePath, ported: forward slashes, collapsed, trimmed. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

export function projectTaskFolder(project: Project): string {
  return project.filePath.replace(/\.md$/, '_tasks')
}

export function toAbsolute(guildRoot: string, vaultPath: string): string {
  return join(guildRoot, ...normalizePath(vaultPath).split('/'))
}

/** A basename of this exact length that prefixes the title's slug is kept as-is. */
const LEGACY_SLUG_CAP = 40

/**
 * Ported from obsidian-pm ProjectStore.resolveTaskPath: new tasks get the bare
 * slug; an existing file stays put while its name still matches the title.
 */
export function resolveTaskPath(task: Task, folder: string, previousPath: string | undefined): string {
  const desired = taskFilePath(task.title, folder)
  if (!previousPath) return desired
  const desiredBasename = desired.slice(desired.lastIndexOf('/') + 1).replace(/\.md$/, '')
  const previousFolder = previousPath.slice(0, previousPath.lastIndexOf('/'))
  const previousBasename = previousPath.slice(previousPath.lastIndexOf('/') + 1).replace(/\.md$/, '')
  if (previousFolder !== folder) return desired
  const legacyBasename = `${desiredBasename}-${task.id.slice(0, 8)}`
  if (previousBasename === legacyBasename) return previousPath
  if (previousBasename.length === LEGACY_SLUG_CAP && previousBasename === desiredBasename.slice(0, LEGACY_SLUG_CAP)) {
    return previousPath
  }
  return desired
}

export class TaskFileNameConflictError extends Error {
  constructor(public readonly path: string) {
    super(`A note named "${fileNameFromPath(path)}" already exists.`)
    this.name = 'TaskFileNameConflictError'
  }

  get fileName(): string {
    return fileNameFromPath(this.path)
  }
}

export function fileNameFromPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
}
