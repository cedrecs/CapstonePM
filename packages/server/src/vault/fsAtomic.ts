import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Write via temp file + rename so a crash mid-write never leaves a truncated
 * markdown file. Node's rename replaces an existing destination on both POSIX
 * and Windows (MoveFileEx with REPLACE_EXISTING).
 */
export async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = dirname(absPath)
  const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await fs.writeFile(tmp, content, 'utf8')
  try {
    await fs.rename(tmp, absPath)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

export async function ensureDir(absPath: string): Promise<void> {
  await fs.mkdir(absPath, { recursive: true })
}

export async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}
