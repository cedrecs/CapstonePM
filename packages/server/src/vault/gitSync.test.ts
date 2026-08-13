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

  it('schedule() is a no-op when disabled', async () => {
    const sync = new GitSync(root, () => undefined, () => false)
    sync.schedule()
    await sync.flush()
    await expect(run('git', ['rev-parse', '--git-dir'], { cwd: root })).rejects.toThrow()
  })
})
