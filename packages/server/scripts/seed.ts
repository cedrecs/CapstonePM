// Seed a demo vault: pnpm --filter @pm/server seed [guildId]
// The result under $VAULT_ROOT/<guildId> can be copied into an Obsidian vault
// with obsidian-pm installed to verify compatibility by eye.
import { env } from '../src/env'
import { GuildVault } from '../src/vault/GuildVault'

const guildId = process.argv[2] ?? 'demo-guild'

async function main(): Promise<void> {
  const vault = await GuildVault.open(guildId, env.vaultRoot)
  if (vault.projects.size > 0) {
    console.log(`vault ${guildId} already has ${vault.projects.size} project(s); not reseeding`)
    return
  }

  const project = await vault.createProject('Senior Capstone Demo')
  await vault.updateProject(project.id, {
    description: 'Demo project seeded by scripts/seed.ts.',
    icon: '🎓',
    color: '#8b72be',
    teamMembers: ['Alice', 'Bob', 'Charlie']
  })

  const { task: proposal } = await vault.insertTask(project.id, {
    title: 'Project Proposal',
    type: 'milestone',
    start: '',
    due: '2026-09-15',
    priority: 'critical'
  })
  const { task: research } = await vault.insertTask(project.id, {
    title: 'Background Research',
    description: 'Survey prior art and interview the sponsor.',
    start: '2026-08-25',
    due: '2026-09-10',
    status: 'in-progress',
    assignees: ['Alice'],
    tags: ['research']
  })
  await vault.insertTask(
    project.id,
    { title: 'Interview sponsor', assignees: ['Bob'], start: '2026-08-28', due: '2026-09-02' },
    research.id
  )
  await vault.insertTask(project.id, {
    title: 'Draft requirements spec',
    dependencies: [research.id],
    start: '2026-09-11',
    due: '2026-09-25',
    assignees: ['Charlie'],
    timeEstimate: 20
  })
  await vault.addTimeLog(project.id, research.id, { date: '2026-08-26', hours: 3, note: 'lit review' })
  await vault.drain()

  console.log(`seeded vault "${guildId}" with project "${project.title}" (${project.id})`)
  console.log(`vault root: ${vault.root}`)
  void proposal
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
