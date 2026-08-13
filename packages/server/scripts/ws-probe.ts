// Dev utility: smoke-test the /ws endpoint directly and through the Vite
// proxy. Assumes a server running with DEV_AUTH=1 and the dev fallback secret.
import WebSocket from 'ws'
import { signSession } from '../src/auth/jwt'

const token = await signSession(
  { userId: 'probe', userName: 'probe', guildId: 'demo-guild', role: 'admin' },
  'dev-secret-do-not-use'
)

function probe(url: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.terminate()
      resolve('timeout')
    }, 4000)
    ws.on('open', () => {
      clearTimeout(timer)
      ws.close()
      resolve('open')
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      resolve(`error: ${e.message}`)
    })
  })
}

console.log('direct :', await probe(`ws://localhost:3000/ws?token=${token}`))
console.log('proxied:', await probe(`ws://localhost:5173/ws?token=${token}`))
