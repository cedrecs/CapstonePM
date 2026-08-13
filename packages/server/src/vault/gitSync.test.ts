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

  it('restores an empty vault root from a remote on sync(true)', async () => {
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

  it('schedule() is a no-op when disabled', async () => {
    const sync = new GitSync(root, () => undefined, () => false)
    sync.schedule()
    await sync.flush()
    await expect(run('git', ['rev-parse', '--git-dir'], { cwd: root })).rejects.toThrow()
  })
})
