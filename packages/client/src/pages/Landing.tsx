import { useState } from 'react'

/**
 * Users normally arrive via a Discord deep link (/g/:guildId/...). This page
 * only exists for direct visits: paste or pick a server to jump in.
 */
export function Landing() {
  const [guildId, setGuildId] = useState('')
  return (
    <div className="page" style={{ maxWidth: 480, marginTop: '15vh', textAlign: 'center' }}>
      <h1>PM for Discord</h1>
      <p className="muted">
        Open the app from a link in your Discord server, or enter your server ID to sign in.
      </p>
      <form
        style={{ display: 'flex', gap: 8, justifyContent: 'center' }}
        onSubmit={(e) => {
          e.preventDefault()
          if (guildId.trim()) location.href = `/g/${guildId.trim()}`
        }}
      >
        <input
          value={guildId}
          onChange={(e) => setGuildId(e.target.value)}
          placeholder="Discord server ID"
          aria-label="Discord server ID"
        />
        <button className="primary" type="submit">
          Open
        </button>
      </form>
    </div>
  )
}
