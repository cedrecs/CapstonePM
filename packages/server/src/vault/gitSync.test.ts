import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitSync } from './gitSync'

const run = promisify(execFile)

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pm-git-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('GitSync', () => {
  it('initializes a repo and commits vault contents', async () => {
    await fs.writeFile(join(root, 'note.md'), 'hello')
    const sync = new GitSync(root, () => undefined, () => true)
    await sync.sync()
    const { stdout } = await run('git', ['log', '--oneline'], { cwd: root })
    expect(stdout).toMatch(/pm sync/)
    // A second sync with no changes is a clean no-op.
    await sync.sync()
    const { stdout: after } = await run('git', ['log', '--oneline'], { cwd: root })
    expect(after.trim().split('\n')).toHaveLength(1)
    // New content produces a second commit.
    await fs.writeFile(join(root, 'note2.md'), 'more')
    await sync.sync()
    const { stdout: final } = await run('git', ['log', '--oneline'], { cwd: root })
    expect(final.trim().split('\n')).toHaveLength(2)
  })

  it('flush() runs a pending debounced commit', async () => {
    await fs.writeFile(join(root, 'note.md'), 'hello')
    const sync = new GitSync(root, () => undefined, () => true)
    sync.schedule()
    await sync.flush()
    const { stdout } = await run('git', ['log', '--oneline'], { cwd: root })
    expect(stdout).toMatch(/pm sync/)
  })

  it('restores an empty vault root from a remote on sync(true)', { timeout: 20_000 }, async () => {
    // Build a "remote": a bare repo seeded with one file.
    const bare = join(root, 'remote.git')
    const seedDir = join(root, 'seed')
    await fs.mkdir(seedDir)
    await run('git', ['init', '--bare', '-b', 'main', bare])
    await fs.writeFile(join(seedDir, 'vault-file.md'), 'from remote')
    const seed = new GitSync(seedDir, () => bare, () => true)
    await seed.sync()

    // Fresh empty dir (Render boot): sync(true) pulls the remote's content.
    const fresh = join(root, 'fresh')
    await fs.mkdir(fresh)
    const restore = new GitSync(fresh, () => bare, () => true)
    await restore.sync(true)
    expect(await fs.readFile(join(fresh, 'vault-file.md'), 'utf8')).toBe('from remote')

    // And local writes flow back to the remote for the next boot.
    await fs.writeFile(join(fresh, 'new-task.md'), 'pushed')
    await restore.sync()
    const again = join(root, 'again')
    await fs.mkdir(again)
    const second = new GitSync(again, () => bare, () => true)
    await second.sync(true)
    expect(await fs.readFile(join(again, 'new-task.md'), 'utf8')).toBe('pushed')
  })

  it('initializes a nested repo instead of hijacking an ancestor repo', async () => {
    // root becomes an outer repo (like Render's app checkout)...
    await run('git', ['init', '-b', 'main'], { cwd: root })
    await run('git', ['config', 'user.email', 'a@b'], { cwd: root })
    await run('git', ['config', 'user.name', 'x'], { cwd: root })
    await run('git', ['remote', 'add', 'origin', 'https://example.invalid/app.git'], { cwd: root })
    // ...with the vault root nested inside it.
    const vaultRoot = join(root, 'data', 'vaults')
    await fs.mkdir(vaultRoot, { recursive: true })
    await fs.writeFile(join(vaultRoot, 'note.md'), 'vault content')

    const sync = new GitSync(vaultRoot, () => undefined, () => true)
    await sync.sync()

    // The vault got its own repo with its own history...
    const { stdout: inner } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: vaultRoot })
    expect(inner.trim().replace(/\\/g, '/').toLowerCase()).toBe(
      vaultRoot.replace(/\\/g, '/').toLowerCase()
    )
    const { stdout: log } = await run('git', ['log', '--oneline'], { cwd: vaultRoot })
    expect(log).toMatch(/pm sync/)
    // ...and the outer repo's remote was left alone.
    const { stdout: outerRemote } = await run('git', ['remote', 'get-url', 'origin'], { cwd: root })
    expect(outerRemote.trim()).toBe('https://example.invalid/app.git')
    // The outer repo has no commits — nothing was committed into it.
    await expect(run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })).rejects.toThrow()
  })

  it('schedule() is a no-op when disabled', async () => {
    const sync = new GitSync(root, () => undefined, () => false)
    sync.schedule()
    await sync.flush()
    await expect(run('git', ['rev-parse', '--git-dir'], { cwd: root })).rejects.toThrow()
  })
})
