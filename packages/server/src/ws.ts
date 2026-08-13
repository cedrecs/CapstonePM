import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { verifySession } from './auth/jwt'
import type { VaultChange } from './vault/GuildVault'
import type { VaultManager } from './vault/VaultManager'

/**
 * One WS endpoint at /ws, authenticated by the session JWT
 * (?token= or the session cookie). Each socket is pinned to its guild and
 * receives that guild's vault change events.
 */
export function attachWebSocket(server: Server, vaults: VaultManager, jwtSecret: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  const guildSockets = new Map<string, Set<WebSocket>>()

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      const cookieToken = /(?:^|;\s*)pm_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      const token = url.searchParams.get('token') ?? cookieToken
      const session = token ? await verifySession(token, jwtSecret) : null
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        let set = guildSockets.get(session.guildId)
        if (!set) {
          set = new Set()
          guildSockets.set(session.guildId, set)
        }
        set.add(ws)
        ws.on('close', () => set.delete(ws))
        // Ensure the vault is open so its change events flow.
        void vaults.get(session.guildId)
      })
    })()
  })

  vaults.on('change', broadcast)

  function broadcast(change: VaultChange): void {
    const sockets = guildSockets.get(change.guildId)
    if (!sockets?.size) return
    const message = JSON.stringify(change)
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(message)
    }
  }

  return wss
}
