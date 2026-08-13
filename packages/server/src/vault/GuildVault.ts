import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import { basename, join } from 'node:path'
import type { PMSettings, Project, ProjectPatch, ResolvedProjectConfig, Task, TimeLog } from '@pm/shared'
import {
  addTaskToTree,
  cloneTaskSubtree,
  computeSchedule,
  wouldCreateCycle,
  deleteTaskFromTree,
  findParentId,
  findTaskById,
  flattenTasks,
  FRONTMATTER_KEY,
  hydrateProjectFromFrontmatter,
  hydrateTaskFromFile,
  indexAddSubtree,
  indexRemoveSubtree,
  indexSetParent,
  isTerminalStatus,
  makeProject,
  makeTask,
  moveTaskInTree,
  parseFrontmatter,
  rebuildTaskIndex,
  resolveProjectConfig,
  sanitizeFileName,
  serializeProject,
  serializeTask,
  TASK_FRONTMATTER_KEY,
  taskFilePath,
  today,
  updateTaskInTree
} from '@pm/shared'
import { atomicWrite, ensureDir, exists } from './fsAtomic'
import { GitSync } from './gitSync'
import {
  normalizePath,
  projectTaskFolder,
  resolveTaskPath,
  TaskFileNameConflictError,
  toAbsolute
} from './paths'
import type { GuildSettings } from './sidecar'
import { loadGuildSettings, saveGuildSettings } from './sidecar'

export interface VaultChange {
  guildId: string
  type: 'project.created' | 'project.updated' | 'project.deleted' | 'settings.updated'
  projectId?: string
  rev?: number
}

export class DependencyCycleError extends Error {
  constructor(taskId: string, depId: string) {
    super(`dependency ${depId} would create a cycle for task ${taskId}`)
    this.name = 'DependencyCycleError'
  }
}

export class RevConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(`rev conflict: expected ${expected}, got ${actual}`)
    this.name = 'RevConflictError'
  }
}

function patchNeedsBodyRewrite(patch: Partial<Task>): boolean {
  return patch.description !== undefined || patch.archived !== undefined || patch.subtasks !== undefined
}

/**
 * One guild's vault on disk: markdown is the source of truth, this class holds
 * the boot-time parse and serializes every mutation through a single queue
 * (mutate in-memory -> atomic file writes -> bump rev -> emit change).
 *
 * Mirrors obsidian-pm's ProjectStore semantics; unlike the plugin there is no
 * metadataCache, so descriptions are always hydrated and every dirty task gets
 * a full rewrite.
 */
export class GuildVault extends EventEmitter {
  /** Live projects by id. Mutators update these objects in place. */
  readonly projects = new Map<string, Project>()
  /** Monotonic per-project revision for optimistic concurrency. */
  private revs = new Map<string, number>()
  private queue: Promise<unknown> = Promise.resolve()
  settings: GuildSettings
  readonly gitSync: GitSync

  private constructor(
    readonly guildId: string,
    readonly root: string,
    settings: GuildSettings
  ) {
    super()
    this.settings = settings
    this.gitSync = new GitSync(
      root,
      () => this.settings.git?.remote,
      () => this.settings.git?.autoCommit ?? !!this.settings.git?.remote
    )
  }

  /** Admin-triggered: pull from the remote, re-scan the vault, commit+push. */
  async syncWithRemote(): Promise<void> {
    await this.gitSync.sync(true)
    await this.enqueue(async () => {
      await this.loadAll()
      for (const id of this.projects.keys()) this.bumpRev(id)
    })
    this.emitChange({ type: 'settings.updated' })
    for (const id of this.projects.keys()) {
      this.emitChange({ type: 'project.updated', projectId: id, rev: this.rev(id) })
    }
  }

  static async open(guildId: string, vaultRoot: string): Promise<GuildVault> {
    const root = join(vaultRoot, guildId)
    await ensureDir(root)
    const settings = await loadGuildSettings(root)
    const vault = new GuildVault(guildId, root, settings)
    await vault.loadAll()
    return vault
  }

  // ---------- config ----------

  private get pmSettings(): PMSettings {
    return this.settings.pm
  }

  get projectsFolder(): string {
    return normalizePath(this.pmSettings.projectsFolder || 'Projects')
  }

  configFor(project: Project): ResolvedProjectConfig {
    return resolveProjectConfig(project, this.pmSettings)
  }

  rev(projectId: string): number {
    return this.revs.get(projectId) ?? 0
  }

  private bumpRev(projectId: string): number {
    const next = this.rev(projectId) + 1
    this.revs.set(projectId, next)
    return next
  }

  private emitChange(change: Omit<VaultChange, 'guildId'>): void {
    this.emit('change', { guildId: this.guildId, ...change } satisfies VaultChange)
  }

  // ---------- loading ----------

  /** Boot-time (or post-git-pull) scan of the whole vault. */
  async loadAll(): Promise<void> {
    this.projects.clear()
    const folderAbs = toAbsolute(this.root, this.projectsFolder)
    await ensureDir(folderAbs)
    const entries = await fs.readdir(folderAbs, { withFileTypes: true })
    const loaded: Project[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const project = await this.readProject(`${this.projectsFolder}/${entry.name}`)
      if (project) loaded.push(project)
    }
    loaded.sort((a, b) => a.title.localeCompare(b.title))
    for (const p of loaded) {
      this.projects.set(p.id, p)
      if (!this.revs.has(p.id)) this.revs.set(p.id, 1)
    }
  }

  private async readProject(vaultPath: string): Promise<Project | null> {
    try {
      const content = await fs.readFile(toAbsolute(this.root, vaultPath), 'utf8')
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter || frontmatter[FRONTMATTER_KEY] !== true) return null
      const base = basename(vaultPath, '.md')
      const project = hydrateProjectFromFrontmatter(frontmatter, body, vaultPath, base)
      const taskIds = Array.isArray(frontmatter.taskIds) ? (frontmatter.taskIds as string[]) : []
      project.tasks = await this.loadTasksFromFolder(projectTaskFolder(project), taskIds)
      rebuildTaskIndex(project)
      return project
    } catch (e) {
      console.error(`[vault:${this.guildId}] failed to load project ${vaultPath}:`, e)
      return null
    }
  }

  /** Ported from ProjectStore.loadTasksFromFolder: tree assembly + orphan self-heal. */
  private async loadTasksFromFolder(folderPath: string, topLevelIds: string[]): Promise<Task[]> {
    const folderAbs = toAbsolute(this.root, folderPath)
    if (!(await exists(folderAbs))) return []

    const files: string[] = []
    const collect = async (dirAbs: string, dirVault: string): Promise<void> => {
      const entries = await fs.readdir(dirAbs, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) files.push(`${dirVault}/${entry.name}`)
        else if (entry.isDirectory()) await collect(join(dirAbs, entry.name), `${dirVault}/${entry.name}`)
      }
    }
    await collect(folderAbs, folderPath)

    const archivePrefix = normalizePath(folderPath + '/Archive') + '/'
    const taskMap = new Map<string, Task>()
    const subtaskIdsMap = new Map<string, string[]>()
    const parentIdMap = new Map<string, string>()

    for (const filePath of files) {
      const { task, subtaskIds, parentId } = await this.loadTaskFile(filePath)
      if (!task) continue
      if (filePath.startsWith(archivePrefix)) task.archived = true
      taskMap.set(task.id, task)
      if (subtaskIds.length) subtaskIdsMap.set(task.id, subtaskIds)
      if (parentId) parentIdMap.set(task.id, parentId)
    }

    for (const [taskId, sids] of subtaskIdsMap) {
      const task = taskMap.get(taskId)
      if (!task) continue
      task.subtasks = []
      for (const sid of sids) {
        const sub = taskMap.get(sid)
        if (sub) task.subtasks.push(sub)
      }
    }

    const childIds = new Set<string>()
    for (const t of taskMap.values()) {
      for (const s of t.subtasks) childIds.add(s.id)
    }
    for (const [taskId, pid] of parentIdMap) {
      if (childIds.has(taskId)) continue
      const parent = taskMap.get(pid)
      const task = taskMap.get(taskId)
      if (!parent || !task) continue
      parent.subtasks.push(task)
      childIds.add(taskId)
      console.warn(`[vault:${this.guildId}] self-healed orphan: "${task.title}" under "${parent.title}"`)
    }

    const result: Task[] = []
    const pushed = new Set<string>()
    for (const id of topLevelIds) {
      if (pushed.has(id)) continue
      const task = taskMap.get(id)
      if (task) {
        result.push(task)
        pushed.add(id)
      }
    }
    for (const task of taskMap.values()) {
      if (!pushed.has(task.id) && !childIds.has(task.id)) result.push(task)
    }
    return result
  }

  private async loadTaskFile(
    vaultPath: string
  ): Promise<{ task: Task | null; subtaskIds: string[]; parentId: string | null }> {
    try {
      const content = await fs.readFile(toAbsolute(this.root, vaultPath), 'utf8')
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter || frontmatter[TASK_FRONTMATTER_KEY] !== true) {
        return { task: null, subtaskIds: [], parentId: null }
      }
      return hydrateTaskFromFile(frontmatter, body, vaultPath)
    } catch (e) {
      console.error(`[vault:${this.guildId}] failed to load task ${vaultPath}:`, e)
      return { task: null, subtaskIds: [], parentId: null }
    }
  }

  // ---------- write path ----------

  /** Serialize all mutations in this guild; saves never interleave. */
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  /** Await all pending writes; called on graceful shutdown. */
  async drain(): Promise<void> {
    await this.queue
  }

  private statusesFor(project: Project) {
    return this.configFor(project).statuses
  }

  /** Write dirty task files then the project file. Runs inside the queue. */
  private async saveProject(project: Project, dirtyTaskIds: Iterable<string>): Promise<void> {
    project.updatedAt = new Date().toISOString()
    const folder = projectTaskFolder(project)
    await ensureDir(toAbsolute(this.root, folder))

    // Tasks that never reached disk are always written.
    const dirty = new Set(dirtyTaskIds)
    for (const [id, entry] of project.taskIndex) {
      if (!entry.task.filePath) dirty.add(id)
    }

    const targetPaths = new Set<string>()
    const jobs: { task: Task; parentTask: Task | null; folder: string }[] = []
    let hasArchived = false
    for (const id of dirty) {
      const entry = project.taskIndex.get(id)
      if (!entry) continue // deleted after being marked dirty
      const { task, parentId } = entry
      const targetFolder = task.archived ? normalizePath(folder + '/Archive') : folder
      if (task.archived) hasArchived = true
      const path = normalizePath(resolveTaskPath(task, targetFolder, task.filePath))
      if (targetPaths.has(path)) throw new TaskFileNameConflictError(path)
      targetPaths.add(path)
      jobs.push({ task, parentTask: parentId ? findTaskById(project, parentId) : null, folder: targetFolder })
    }
    if (hasArchived) await ensureDir(toAbsolute(this.root, folder + '/Archive'))

    for (const job of jobs) {
      await this.saveTaskFile(job.task, project, job.parentTask, job.folder)
    }

    await atomicWrite(
      toAbsolute(this.root, project.filePath),
      serializeProject(project, this.statusesFor(project))
    )
  }

  private async saveTaskFile(task: Task, project: Project, parentTask: Task | null, folder: string): Promise<void> {
    const previousPath = task.filePath
    const filePath = normalizePath(resolveTaskPath(task, folder, previousPath))
    const renamed = previousPath !== undefined && previousPath !== filePath

    if (renamed || !previousPath) {
      // Another task's file (or an unrelated note) already at the target is a conflict.
      if ((await exists(toAbsolute(this.root, filePath))) && filePath !== previousPath) {
        throw new TaskFileNameConflictError(filePath)
      }
    }

    const content = serializeTask(task, project, parentTask, this.statusesFor(project))
    await atomicWrite(toAbsolute(this.root, filePath), content)
    task.filePath = filePath

    if (renamed && previousPath) {
      await this.trash(previousPath)
      // Keep the task's attachment folder with the renamed note.
      const oldAttach = previousPath.replace(/\.md$/, '')
      const newAttach = filePath.replace(/\.md$/, '')
      if ((await exists(toAbsolute(this.root, oldAttach))) && !(await exists(toAbsolute(this.root, newAttach)))) {
        await fs.rename(toAbsolute(this.root, oldAttach), toAbsolute(this.root, newAttach))
      }
    }
  }

  /** Recoverable delete: move into the vault's .trash, like Obsidian's default. */
  private async trash(vaultPath: string): Promise<void> {
    const abs = toAbsolute(this.root, vaultPath)
    if (!(await exists(abs))) return
    const trashDir = join(this.root, '.trash')
    await ensureDir(trashDir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.rename(abs, join(trashDir, `${stamp}-${basename(abs)}`))
  }

  private assertRev(projectId: string, expectedRev: number | undefined): void {
    if (expectedRev === undefined) return // explicit override: last write wins
    const actual = this.rev(projectId)
    if (expectedRev !== actual) throw new RevConflictError(expectedRev, actual)
  }

  private mustProject(projectId: string): Project {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`unknown project ${projectId}`)
    return project
  }

  /** Common tail of every mutation: save, bump, emit, schedule git commit. */
  private async commit(project: Project, dirty: Iterable<string>): Promise<number> {
    await this.saveProject(project, dirty)
    const rev = this.bumpRev(project.id)
    this.emitChange({ type: 'project.updated', projectId: project.id, rev })
    this.gitSync.schedule()
    return rev
  }

  // ---------- project mutations ----------

  async createProject(title: string): Promise<Project> {
    return this.enqueue(async () => {
      const safeName = sanitizeFileName(title)
      const filePath = normalizePath(`${this.projectsFolder}/${safeName}.md`)
      if (await exists(toAbsolute(this.root, filePath))) {
        throw new TaskFileNameConflictError(filePath)
      }
      const project = makeProject(title, filePath)
      await ensureDir(toAbsolute(this.root, projectTaskFolder(project)))
      await this.saveProject(project, [])
      this.projects.set(project.id, project)
      this.revs.set(project.id, 1)
      this.emitChange({ type: 'project.created', projectId: project.id, rev: 1 })
      return project
    })
  }

  async updateProject(projectId: string, patch: ProjectPatch, expectedRev?: number): Promise<number> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      Object.assign(project, patch)
      return this.commit(project, [])
    })
  }

  async deleteProject(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      const taskFolderAbs = toAbsolute(this.root, projectTaskFolder(project))
      // Trash the whole task folder, then the project file — recoverable.
      if (await exists(taskFolderAbs)) {
        const trashDir = join(this.root, '.trash')
        await ensureDir(trashDir)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await fs.rename(taskFolderAbs, join(trashDir, `${stamp}-${basename(taskFolderAbs)}`))
      }
      await this.trash(project.filePath)
      this.projects.delete(projectId)
      this.revs.delete(projectId)
      this.emitChange({ type: 'project.deleted', projectId })
    })
  }

  // ---------- task mutations (semantics mirror ProjectStore) ----------

  /**
   * Stamp or clear `completed` when a status crosses the complete boundary.
   * An explicit `completed` in the patch wins.
   */
  private stampCompletion(project: Project, task: Task, patch: Partial<Task>): void {
    if (patch.status === undefined) return
    if (patch.completed !== undefined && patch.completed !== task.completed) return
    const statuses = this.statusesFor(project)
    const wasComplete = isTerminalStatus(task.status, statuses)
    const nowComplete = isTerminalStatus(patch.status, statuses)
    if (nowComplete && !wasComplete) patch.completed = today().toString()
    else if (!nowComplete && wasComplete) patch.completed = ''
  }

  private completionMoved(task: Task, patch: Partial<Task>): boolean {
    return patch.completed !== undefined && patch.completed !== task.completed
  }

  async insertTask(
    projectId: string,
    init: Partial<Task>,
    parentId: string | null = null,
    expectedRev?: number
  ): Promise<{ task: Task; rev: number }> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      const task = makeTask(init)
      if (!task.completed && isTerminalStatus(task.status, this.statusesFor(project))) {
        task.completed = today().toString()
      }
      addTaskToTree(project.tasks, task, parentId)
      indexAddSubtree(project, task, parentId)
      const dirty = [task.id, ...(parentId ? [parentId] : [])]
      const rev = await this.commit(project, dirty)
      return { task, rev }
    })
  }

  async updateTask(
    projectId: string,
    taskId: string,
    patch: Partial<Task>,
    expectedRev?: number
  ): Promise<number> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      const task = findTaskById(project, taskId)
      if (!task) throw new Error(`unknown task ${taskId}`)
      // Tree shape changes go through moveTask/reorderTask/deleteTasks.
      delete (patch as Record<string, unknown>).subtasks
      if (patch.dependencies) {
        const existing = new Set(task.dependencies)
        for (const dep of patch.dependencies) {
          if (existing.has(dep)) continue
          if (dep === taskId || wouldCreateCycle(project.tasks, taskId, dep)) {
            throw new DependencyCycleError(taskId, dep)
          }
        }
      }
      const oldTitle = task.title
      this.stampCompletion(project, task, patch)
      const completionMoved = this.completionMoved(task, patch)
      const schedulingTouched =
        patch.start !== undefined || patch.due !== undefined || patch.dependencies !== undefined
      updateTaskInTree(project.tasks, taskId, patch)
      const dirty = new Set([taskId])
      if (patch.title !== undefined && patch.title !== oldTitle) {
        // The rename breaks direct children's Parent link.
        for (const sub of task.subtasks) dirty.add(sub.id)
      }
      if (schedulingTouched || (completionMoved && this.configFor(project).pullForwardOnEarlyFinish)) {
        this.applySchedule(project, taskId, dirty)
      }
      return this.commit(project, dirty)
    })
  }

  /** Patch several tasks in one save (bulk actions). */
  async updateTasks(
    projectId: string,
    taskIds: string[],
    patch: Partial<Task>,
    expectedRev?: number
  ): Promise<number> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      const dirty = new Set<string>()
      const scheduleIds: string[] = []
      for (const id of taskIds) {
        const task = findTaskById(project, id)
        if (!task) continue
        const p: Partial<Task> = { ...patch }
        delete (p as Record<string, unknown>).subtasks
        this.stampCompletion(project, task, p)
        if (this.completionMoved(task, p)) scheduleIds.push(id)
        const oldTitle = task.title
        updateTaskInTree(project.tasks, id, p)
        dirty.add(id)
        if (p.title !== undefined && p.title !== oldTitle) {
          for (const sub of task.subtasks) dirty.add(sub.id)
        }
        if (p.start !== undefined || p.due !== undefined || p.dependencies !== undefined) {
          scheduleIds.push(id)
        }
      }
      for (const id of scheduleIds) this.applySchedule(project, id, dirty)
      return this.commit(project, dirty)
    })
  }

  async moveTask(
    projectId: string,
    taskId: string,
    newParentId: string | null,
    expectedRev?: number
  ): Promise<number> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      const task = findTaskById(project, taskId)
      if (!task) throw new Error(`unknown task ${taskId}`)
      const oldParentId = findParentId(project, taskId)
      deleteTaskFromTree(project.tasks, taskId)
      addTaskToTree(project.tasks, task, newParentId)
      indexSetParent(project, taskId, newParentId)
      const dirty = new Set([taskId])
      if (oldParentId) dirty.add(oldParentId)
      if (newParentId) dirty.add(newParentId)
      return this.commit(project, dirty)
    })
  }

  async reorderTask(
    projectId: string,
    taskId: string,
    targetId: string,
    position: 'before' | 'after',
    expectedRev?: number
  ): Promise<number> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      if (!moveTaskInTree(project.tasks, taskId, targetId, position)) return this.rev(projectId)
      const parentId = findParentId(project, targetId)
      // Sibling order lives in the parent's subtaskIds (or the project's taskIds).
      return this.commit(project, parentId ? [parentId] : [])
    })
  }

  async deleteTasks(projectId: string, taskIds: string[], expectedRev?: number): Promise<number> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      const dirty = new Set<string>()
      for (const id of taskIds) {
        const parentId = findParentId(project, id)
        if (parentId) dirty.add(parentId)
        const task = findTaskById(project, id)
        if (task) {
          await this.trashTaskFiles(task)
          indexRemoveSubtree(project, task)
        }
        deleteTaskFromTree(project.tasks, id)
        dirty.delete(id)
      }
      return this.commit(project, dirty)
    })
  }

  private async trashTaskFiles(task: Task): Promise<void> {
    for (const sub of task.subtasks) await this.trashTaskFiles(sub)
    if (task.filePath) {
      await this.trash(task.filePath)
      const attach = task.filePath.replace(/\.md$/, '')
      if (await exists(toAbsolute(this.root, attach))) {
        const trashDir = join(this.root, '.trash')
        await ensureDir(trashDir)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await fs.rename(toAbsolute(this.root, attach), join(trashDir, `${stamp}-${basename(attach)}`))
      }
    }
  }

  /** Archive = move the file subtree into Archive/; archived is derived, never stored. */
  async setArchived(projectId: string, taskId: string, archived: boolean, expectedRev?: number): Promise<number> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      const task = findTaskById(project, taskId)
      if (!task) throw new Error(`unknown task ${taskId}`)
      const dirty = new Set<string>()
      for (const ft of [{ task }, ...flattenTasks(task.subtasks)]) {
        ft.task.archived = archived
        dirty.add(ft.task.id)
      }
      return this.commit(project, dirty)
    })
  }

  async duplicateTask(
    projectId: string,
    sourceId: string,
    includeSubtasks: boolean,
    expectedRev?: number
  ): Promise<{ task: Task; rev: number }> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      const source = findTaskById(project, sourceId)
      if (!source) throw new Error(`unknown task ${sourceId}`)
      const copy = cloneTaskSubtree(source, includeSubtasks)
      const baseFolder = projectTaskFolder(project)
      const usedTitles = new Set(flattenTasks(project.tasks).map((f) => f.task.title))
      const claimed = new Set<string>()
      for (const node of [copy, ...flattenTasks(copy.subtasks).map((f) => f.task)]) {
        const folder = node.archived ? normalizePath(baseFolder + '/Archive') : baseFolder
        await this.assignCopyName(node, folder, usedTitles, claimed)
      }
      const parentId = findParentId(project, sourceId)
      addTaskToTree(project.tasks, copy, parentId)
      moveTaskInTree(project.tasks, copy.id, sourceId, 'after')
      indexAddSubtree(project, copy, parentId)
      const dirty = new Set([copy.id, ...flattenTasks(copy.subtasks).map((f) => f.task.id)])
      if (parentId) dirty.add(parentId)
      const rev = await this.commit(project, dirty)
      return { task: copy, rev }
    })
  }

  /** Ported from ProjectStore.assignCopyName; fs existence replaces the vault lookup. */
  private async assignCopyName(
    task: Task,
    folder: string,
    usedTitles: Set<string>,
    claimed: Set<string>
  ): Promise<void> {
    const TASK_SLUG_MAX_LENGTH = 60
    const base = task.title.replace(/(?: \(copy(?: \d+)?\))+$/, '')
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`
      const room = TASK_SLUG_MAX_LENGTH - suffix.length
      const title = (base.length > room ? base.slice(0, room).trimEnd() : base) + suffix
      const path = normalizePath(taskFilePath(title, folder))
      if (!usedTitles.has(title) && !claimed.has(path) && !(await exists(toAbsolute(this.root, path)))) {
        usedTitles.add(title)
        claimed.add(path)
        task.title = title
        return
      }
    }
  }

  async addTimeLog(projectId: string, taskId: string, log: TimeLog, expectedRev?: number): Promise<number> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId)
      this.assertRev(projectId, expectedRev)
      const task = findTaskById(project, taskId)
      if (!task) throw new Error(`unknown task ${taskId}`)
      const timeLogs = [...(task.timeLogs ?? []), log]
      updateTaskInTree(project.tasks, taskId, { timeLogs })
      return this.commit(project, [taskId])
    })
  }

  /** Dependency-based scheduling; mutates the tree and extends `dirty` in place. */
  private applySchedule(project: Project, changedTaskId: string, dirty: Set<string>): void {
    const config = this.configFor(project)
    if (!config.autoSchedule) return
    const { patches } = computeSchedule(
      project.tasks,
      changedTaskId,
      config.statuses,
      config.pullForwardOnEarlyFinish
    )
    for (const p of patches) {
      updateTaskInTree(project.tasks, p.taskId, { start: p.start, due: p.due })
      dirty.add(p.taskId)
    }
  }

  // ---------- settings ----------

  async updateSettings(patch: Partial<GuildSettings>): Promise<void> {
    return this.enqueue(async () => {
      const git = patch.git !== undefined ? patch.git : this.settings.git
      this.settings = {
        version: 1,
        pm: { ...this.settings.pm, ...(patch.pm ?? {}) },
        discord: { ...this.settings.discord, ...(patch.discord ?? {}) },
        ...(git ? { git } : {})
      }
      await saveGuildSettings(this.root, this.settings)
      this.emitChange({ type: 'settings.updated' })
    })
  }

  /** Flush pending writes and any pending git commit; called on shutdown. */
  async shutdown(): Promise<void> {
    await this.drain()
    await this.gitSync.flush()
  }
}
