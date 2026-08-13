import type { Project, Task } from '@pm/shared'

export interface Session {
  userId: string
  userName: string
  guildId: string
  role: 'admin' | 'member' | 'advisor' | 'sponsor'
}

export type ProjectDTO = Omit<Project, 'taskIndex'> & { rev: number }
export type ProjectSummaryDTO = Omit<ProjectDTO, 'tasks'> & { taskCount: number; doneCount: number }

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(`API ${status}`)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) {
    // Session missing/expired: bounce through Discord login, preserving the deep link.
    const guildId = location.pathname.match(/^\/g\/([^/]+)/)?.[1]
    if (guildId) {
      location.href = `/auth/login?guild=${guildId}&redirect=${encodeURIComponent(location.pathname)}`
    }
    throw new ApiError(401, null)
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  return (await res.json()) as T
}

export const api = {
  me: () => request<Session>('GET', '/api/me'),
  projects: () => request<ProjectSummaryDTO[]>('GET', '/api/projects'),
  project: (pid: string) => request<ProjectDTO>('GET', `/api/projects/${pid}`),
  createProject: (title: string) => request<ProjectDTO>('POST', '/api/projects', { title }),
  updateProject: (pid: string, patch: Record<string, unknown>, rev?: number) =>
    request<{ rev: number }>('PATCH', `/api/projects/${pid}`, { ...patch, rev }),
  addTask: (pid: string, init: Partial<Task> & { parentId?: string | null }, rev?: number) =>
    request<{ task: Task; rev: number }>('POST', `/api/projects/${pid}/tasks`, { ...init, rev }),
  updateTask: (pid: string, tid: string, patch: Partial<Task>, rev?: number) =>
    request<{ rev: number }>('PATCH', `/api/projects/${pid}/tasks/${tid}`, { ...patch, rev }),
  deleteTasks: (pid: string, taskIds: string[], rev?: number) =>
    request<{ rev: number }>('POST', `/api/projects/${pid}/tasks/delete`, { taskIds, rev }),
  bulkPatch: (pid: string, taskIds: string[], patch: Partial<Task>, rev?: number) =>
    request<{ rev: number }>('POST', `/api/projects/${pid}/tasks/bulk`, { taskIds, patch, rev })
}

/** Live vault changes for the current guild; reconnects with backoff. */
export function openChangeSocket(onChange: (change: { projectId?: string }) => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let retry = 1000

  const connect = (): void => {
    if (closed) return
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    ws.onmessage = (e) => {
      try {
        onChange(JSON.parse(e.data as string) as { projectId?: string })
      } catch {
        // ignore malformed frames
      }
    }
    ws.onopen = () => {
      retry = 1000
    }
    ws.onclose = () => {
      if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 15000)))
    }
  }
  connect()
  return () => {
    closed = true
    ws?.close()
  }
}
