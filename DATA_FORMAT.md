# Data format

The on-disk format is byte-compatible with [obsidian-pm](https://github.com/StepanKropachev/obsidian-pm); the golden tests in `packages/shared/src/store/byte-stability.test.ts` pin it. This file documents behaviors that aren't obvious from the frontmatter schema.

## Layout (per guild, under `$VAULT_ROOT/{guild_id}/`)

```
Projects/
  my-project.md                # pm-project: true
  my-project_tasks/            # task folder = project filename + "_tasks"
    some-task.md               # pm-task: true; slugified title, max 60 chars (dots kept)
    some-task/                 # optional attachment folder, same basename
    Archive/                   # archived tasks — "archived" is DERIVED from location
pm-settings.json               # sidecar (this port only; Obsidian ignores it)
.trash/                        # deleted files, timestamped (like Obsidian's trash)
```

- Task file slugs come from `sanitizeFileName(title).toLowerCase().replace(/\s+/g, '-')` capped at 60 chars. Dots survive: "Ship v1.0" → `ship-v1.0.md`.
- Renaming a task renames its file (and moves its attachment folder); the old file goes to `.trash/`.
- `archived` never appears in frontmatter — it is derived from being under `Archive/`.

## Recurrence

**The reference plugin (v1.8.0) stores and displays `recurrence` but never materializes occurrences** — completing a recurring task does not spawn the next instance. This port matches that exactly (scope §9 Q4): `recurrence {interval, every, endDate?}` round-trips through frontmatter and is editable in the task editor, and nothing is auto-created. If upstream adds materialization later, mirror its semantics here.

## Sidecar: `pm-settings.json`

Guild-level state the plugin keeps in its own `data.json`, plus Discord-specific maps:

```jsonc
{
  "version": 1,
  "pm": { /* PMSettings: statuses, priorities, scheduling flags, notification config, ... */ },
  "discord": {
    "roleMap":        { "<discord role id>": "admin|member|advisor|sponsor" },
    "userMap":        { "<discord user id>": "Assignee Name" },
    "channelBindings":{ "<project id>": { "channelId": "...", "messageId": "..." } },
    "remindedAt":     { "<task id>": "YYYY-MM-DD" }   // due-reminder dedup
  }
}
```

## Concurrency

- One serialized write queue per guild; every markdown write is atomic (temp file + rename).
- Optimistic concurrency: each project has an in-memory `rev`; mutations carrying a stale `rev` get HTTP 409. Omitting `rev` is an explicit last-write-wins override.
- Dependency edges that would close a cycle are refused with HTTP 409 (`dependency-cycle`).

## Body content

File bodies are auto-generated for Obsidian browsing (headings, wikilink checklists, `Project:`/`Parent:` backlinks) and stripped on parse. A parent task's `## Subtasks` checkbox list refreshes when that parent is next rewritten — not on every child status change — matching the reference plugin. The project file's `## Tasks` checklist refreshes on every project save.
