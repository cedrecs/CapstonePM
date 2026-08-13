# PM for Discord

A self-hosted, web-first project management platform for university capstone teams, with deep Discord integration (live status embeds, `/pm` slash commands, due-date reminders, deep links).

All project and task data is stored as plain Markdown files with YAML frontmatter, **byte-compatible with the [Project Manager for Obsidian](https://github.com/StepanKropachev/obsidian-pm) plugin** — any team's vault can be copied into an Obsidian vault and opened with the original plugin, or handed off wholesale at semester end.

## Packages

- `packages/shared` — types, YAML serialization, scheduling, and task-tree logic ported from obsidian-pm (the single schema source)
- `packages/server` — Fastify REST API, WebSocket broadcast, Discord bot, vault store
- `packages/client` — React SPA (Table / Kanban / Gantt views)

## Attribution

The data model, YAML serializer/parser, scheduler, and task-tree operations in `packages/shared` are ported from [obsidian-pm](https://github.com/StepanKropachev/obsidian-pm) by Stepan Kropachev, used under the MIT license. See [LICENSE](LICENSE).

## Development

```bash
pnpm install
pnpm test
```

Requires Node >= 24 and pnpm.
