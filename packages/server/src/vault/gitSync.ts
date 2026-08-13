import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** git errors put the useful text on stderr; surface it in one log line. */
function gitError(e: unknown): string {
  const err = e as { message?: string; stderr?: string }
  return (err.stderr?.trim() || err.message || String(e)).split('\n').join(' | ')
}

/**
 * Optional per-guild git sync: the guild's vault directory becomes its own git
 * repo. Auto-commit is debounced ~30s after the last write; push happens when
 * a remote is configured. This doubles as offsite backup and the Obsidian
 * bridge (clone the repo into a vault).
 */
export class GitSync {
  private timer: NodeJS.Timeout | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private root: string,
    private getRemote: () => string | undefined,
    private getEnabled: () => boolean,
    private debounceMs = GitSync.DEBOUNCE_MS
  ) {}

  static readonly DEBOUNCE_MS = 30_000

  private git(...args: string[]) {
    return run('git', args, { cwd: this.root })
  }

  /**
   * True only when `root` is itself a repo top-level. A bare --git-dir probe
   * would also match an ANCESTOR repo (e.g. the app checkout containing
   * data/vaults), and every command would then operate on that repo —
   * rewriting its origin and pushing the app's history to the vault remote.
   */
  private async isRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.git('rev-parse', '--show-toplevel')
      const norm = (p: string): string => p.trim().replace(/\\/g, '/').toLowerCase()
      return norm(stdout) === norm(resolve(this.root))
    } catch {
      return false
    }
  }

  private async ensureRepo(): Promise<void> {
    if (!(await this.isRepo())) {
      await this.git('init', '-b', 'main')
      await this.git('config', 'user.name', 'PM for Discord')
      await this.git('config', 'user.email', 'pm-bot@localhost')
    }
    const remote = this.getRemote()
    if (remote) {
      try {
        await this.git('remote', 'add', 'origin', remote)
      } catch {
        await this.git('remote', 'set-url', 'origin', remote)
      }
    }
  }

  /** Debounced auto-commit after a vault write. No-op when sync is disabled. */
  schedule(): void {
    if (!this.getEnabled()) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.sync().catch((e) => console.error('[git] auto-commit failed', e))
    }, this.debounceMs)
  }

  /**
   * Serialize sync operations: commit local state, optionally rebase on the
   * remote, push. Committing before the pull keeps the rebase clean and makes
   * this safe as a boot-restore on an empty directory (the pull then fast-
   * forwards to the remote's content).
   */
  sync(pull = false): Promise<void> {
    const work = async (): Promise<void> => {
      await this.ensureRepo()
      const remote = this.getRemote()
      const tryPull = async (): Promise<void> => {
        try {
          await this.git('pull', '--rebase', 'origin', 'main')
        } catch (e) {
          // First sync has no upstream yet; later failures are surfaced in the log.
          console.warn('[git] pull skipped:', gitError(e))
        }
      }
      // An unborn branch must pull before anything touches the index: even a
      // no-op `git add` leaves an index file that makes the pull refuse
      // ("Updating an unborn branch with changes added to the index").
      const unborn = !(await this.hasCommits())
      if (pull && remote && unborn) await tryPull()
      await this.git('add', '-A')
      try {
        await this.git('commit', '-m', `pm sync ${new Date().toISOString()}`)
      } catch {
        // nothing to commit
      }
      if (pull && remote && !unborn) await tryPull()
      if (remote) {
        try {
          await this.git('push', '-u', 'origin', 'main')
        } catch (e) {
          console.error('[git] push failed:', gitError(e))
        }
      }
    }
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => {})
    return next
  }

  private async hasCommits(): Promise<boolean> {
    try {
      await this.git('rev-parse', '--verify', 'HEAD')
      return true
    } catch {
      return false
    }
  }

  /** Run any pending debounced commit now; called on graceful shutdown. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      await this.sync().catch((e) => console.error('[git] flush failed', e))
    }
    await this.chain
  }
}
