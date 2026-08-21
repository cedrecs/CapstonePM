# Design Handoff — PM for Discord

**Purpose:** document the web app's current UI/UX exactly as built, so it can be redesigned in another tool or by another person without reverse-engineering the code first. Nothing in this document is a redesign recommendation — it is a snapshot of what exists today, as of **2026-08-13**.

No pixel screenshots are included (not capturable in the authoring session); every screen is instead specified precisely enough to rebuild from description alone — layout order, states, copy, and exact token values.

---

## 1. Product & audience, in brief

A self-hosted project-management web app for university capstone teams, replicating the Obsidian "Project Manager" plugin's data model with a Discord bot layered on top. Full scope: `obsidian-pm-discord-scope.md` in the repo owner's Downloads folder. Data format is fixed and out of scope for any UI redesign — see `DATA_FORMAT.md`.

Primary device is a laptop browser; mobile is a required secondary surface ("students live on phones" — scope §3.1), currently handled with one CSS breakpoint (640px) rather than a distinct mobile layout.

## 2. Roles and how the UI already differs by role

Four roles, resolved from Discord server roles: **Admin**, **Member**, **Advisor**, **Sponsor**. The UI reads `me.role` from `/api/me` and branches in two ways only:

| Capability | Admin | Member | Advisor | Sponsor |
|---|---|---|---|---|
| See projects, tasks, all views | ✓ | ✓ | ✓ | ✓ |
| Edit tasks (status, dates, assignees, etc.) | ✓ | ✓ | — | — |
| Create / delete projects | ✓ | — | — | — |
| Project settings (⚙ icon), guild settings | ✓ | — | — | — |

Where write access is off, editable controls (selects, inputs, buttons) are replaced with plain text/badges — there is no separate "read-only theme," just conditional rendering of the same layout. This is the only place role currently shapes the UI; there's no dashboard/summary view tailored to Advisor or Sponsor yet (scope §4 calls for read-only *summary surfaces* for Sponsor specifically — not yet built).

## 3. Information architecture (routes)

```
/                                        Landing — manual guild-ID entry (fallback only; normal entry is a Discord deep link)
/g/:guildId                              → redirects to /g/:guildId/p
/g/:guildId/p                            Projects list
/g/:guildId/p/:projectId                 Project workspace (Table default, or Kanban/Gantt via toggle)
/g/:guildId/p/:projectId/t/:taskId       Same workspace, with the task editor drawer open
/g/:guildId/settings                     Guild settings (admin-only)
```

All routes except `/` sit inside a shared shell (top bar + outlet). There is no breadcrumb; the only way back to the project list is the "📋 PM" logo in the top bar.

## 4. Current design tokens

Single dark theme, no light mode, no user-facing theme toggle. Defined as CSS custom properties on `:root` in `styles.css`:

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#1e1f26` | Page background |
| `--bg-raised` | `#262832` | Cards, top bar, drawers, table-adjacent surfaces |
| `--bg-hover` | `#2e3140` | Hover state on rows, buttons, cards |
| `--border` | `#3a3d4d` | All hairline borders/dividers |
| `--text` | `#e6e6ec` | Primary text |
| `--text-dim` | `#9a9dad` | Secondary/meta text, placeholders, column headers |
| `--accent` | `#8b72be` | Links, primary buttons, focus ring, active view-switcher tab |
| `--danger` | `#c47070` | Delete actions, error banners |
| `--ok` | `#79b58d` | (declared, minimally used today) |

Per-project and per-guild **status/priority colors** are user-editable (hex color pickers in Settings) and stored in data — they are content, not part of the design system, and currently render as free-form hex with no palette guardrails or contrast checking.

**Typography:** one stack everywhere — `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`. No type scale beyond browser defaults for `h2`/`h3`; body text and UI controls are ~14px, table headers 12px uppercase with letter-spacing, field labels 12px uppercase.

**Shape/spacing:** border-radius 6px (buttons/inputs), 8–10px (cards, badges use a full pill), consistent gap-based spacing at 6/8/10/12/16px, no defined spacing scale beyond "whatever the component needed."

**Breakpoint:** one, at `640px` — hides secondary table columns (Priority, Progress, Assignees, Tags) and narrows the Gantt label column. Kanban and Gantt otherwise stay horizontally scrollable on mobile rather than restacking.

## 5. Component inventory

Patterns that repeat across screens (component names below are informal — there is no component library, just shared CSS classes over plain HTML elements):

- **Top bar** — sticky, `--bg-raised`, logo left, settings gear + user identity (`name · role`) right.
- **Drawer** — fixed right-side panel, `min(480px, 100vw)` wide, full height, used for both the task editor and project settings. Never a modal/overlay-with-backdrop — the page behind stays visible and scrollable.
- **Filter bar** — a wrapping row of plain `<select>` elements (status, priority, assignee, tag, due-date window) plus a text search input and an "Archived" checkbox, right-aligned saved-views picker.
- **Bulk action bar** — appears only when ≥1 table row is selected; same visual language as the filter bar but framed in an accent-colored border.
- **Badge** — pill shape, used for status labels (colored per-status), tags, "archived" flag.
- **Chip** — like a badge but with an inline "×" remove button; used for assignees, tags, and dependencies inside the task editor.
- **Task table** — dense, sortable-header, one row per task (flattened tree with manual indent), inline-editable cells (status/priority as `<select>`, due as `<input type=date>`, progress as `<input type=number>`, title as click-to-open rather than inline).
- **Kanban board** — horizontal-scroll row of fixed-240px columns, drag-and-drop cards (`@dnd-kit`) between status columns.
- **Gantt** — custom SVG, not a library: day/week/month/quarter zoom, draggable/resizable bars, elbow-path dependency arrows, diamond milestones, a red "today" line, a fixed-width label column on the left.
- **Form field** — a vertical stack of a 12px uppercase label + one control; multiple fields wrap in a `field-row` when short enough to sit side-by-side (used throughout the task editor and settings).

## 6. Screen-by-screen spec

### 6.1 Landing (`/`)

Centered single column, ~480px wide, vertically centered with generous top margin. Heading, one line of body copy, a text input (Discord server ID) + "Open" button. This screen only appears on a direct/bookmarked visit — the intended entry point is always a Discord deep link straight into `/g/:guildId/...`.

### 6.2 Shell top bar (all authenticated routes)

Logo (「📋 PM」, links to the project list) — spacer — ⚙️ settings link (admin only) — 「name · role」text. No navigation beyond that; no notifications, no search, no avatar image (text only).

### 6.3 Projects list (`/g/:guildId/p`)

`<h2>Projects</h2>`, then (admin only) a one-line "new project name" input + Create button, then a responsive card grid (`auto-fill, minmax(240px, 1fr)`). Each card: icon + title, and a meta line "`X/Y tasks done`". Empty state is a single muted line, "No projects yet." No project thumbnails, no color-coding on the card itself beyond the emoji icon (the project's `color` field is stored but not yet rendered anywhere in this list).

### 6.4 Project workspace (`/g/:guildId/p/:projectId`)

Shared header for all three view modes: `<h2>icon title</h2>` left, a view-switcher (Table / Kanban / Gantt buttons, active one styled `.primary`) plus the ⚙ project-settings button, right-aligned. Below that, always present regardless of view mode: a conflict banner (conditional), the filter bar, and (if writable) the quick-add form. The view body renders below that row.

**Table mode (default):** bulk-action bar (conditional) → table with columns Select · Task · Status · Priority · Due · Progress · Assignees · Tags (last four hidden under 640px) → empty state "No tasks match." Row indentation shows subtask depth; a ▾/▸ toggle collapses subtrees (persisted in `localStorage`, not per-user account state).

**Kanban mode:** one checkbox ("Show subtasks as cards") above a horizontally-scrolling row of status columns, each showing its label, a task count, and stacked cards.

**Gantt mode:** a toolbar (Day/Week/Month/Quarter zoom buttons + "Hide done" checkbox) above a bordered panel split into a fixed label column and a horizontally-scrolling SVG timeline.

### 6.5 Task editor (drawer, `/g/.../t/:taskId`)

Opened by clicking any task title in the table. Top: editable title input + ✕ close. Then, in order: description textarea, a three-up row (type / status / priority selects), a three-up row (start / due / progress), assignees (chips + add), tags (chips + add), dependencies (chips + add, cycle-checked server-side with an inline error banner on rejection), a repeat/recurrence row (interval, every-N, end date — **stored and editable but never materializes new task instances**, matching the reference plugin's own behavior), a time section (estimate input, a logged-vs-estimate progress bar, a list of past log entries, an add-log mini-form), then any project-defined custom fields (all 8 types: text/number/date/select/multiselect/person/checkbox/url), and finally an action row: Archive/Unarchive, Duplicate, Delete (destructive, confirms via `window.confirm`).

### 6.6 Project settings (drawer, ⚙ next to the view switcher)

Icon + title + color (native color picker) on one row, description textarea, team-members chip editor, a custom-field-definition editor (add/remove/configure per-project fields), then a block of per-project overrides that each explicitly default to "(inherit)" from the guild-level settings: default view, auto-schedule, pull-forward-on-early-finish, kanban-subtasks-as-cards, plus optional fully-custom status and priority palettes (each entry: id, label, color swatch, and for statuses a "done" checkbox). Admin-only "Delete project" action at the bottom.

### 6.7 Guild settings (`/g/:guildId/settings`, admin-only, full page not a drawer)

Six stacked card-style sections, each `.settings-section`: **Team roster** (chip list), **Statuses** (editable table: id/label/color/done-checkbox/remove, plus an add-row), **Priorities** (same, no done-checkbox), **Scheduling & notifications** (four checkbox/number rows), **Discord role mapping** (manual role-ID → app-role map — no live picker of the guild's actual roles), **Discord user → assignee name** (manual user-ID → free-text-name map). One "Save settings" button at the bottom for the whole page, with an inline "Saved ✓" / "Save failed" indicator next to it.

## 7. Interaction patterns

- **No modals for editing** — task and project settings both use the same right-side drawer pattern instead. `window.confirm`/`window.prompt` are used only for two destructive/naming actions (delete, save-view naming) — the one place native browser dialogs appear.
- **Optimistic-ish mutation + explicit conflict recovery** — every write carries the project's last-known `rev`; a stale write gets HTTP 409, which the UI surfaces as a banner ("Someone else changed this project — the latest state has been reloaded") rather than silently overwriting or silently discarding the user's change. A second, distinct banner covers dependency-cycle rejections specifically.
- **Inline-edit-in-place** for structured fields (selects, date/number inputs edit directly in the table row or drawer field); free-text fields (title, description) commit on blur, not on every keystroke.
- **Saved views** capture filter + sort + view-mode together and are stored on the project itself (visible to the whole team, not per-user).
- **Live updates** — a WebSocket pushes vault-change events; any change to the open project (from another tab, another user, or the Discord bot) triggers a background refetch, no manual refresh needed.

## 8. Responsive behavior today

Below 640px: four table columns hide, the Gantt label column narrows to 140px, and page padding tightens. Everything else — the Kanban board, the Gantt SVG, the drawer width, the filter bar's wrapping `<select>` row — uses the same layout as desktop, which on a phone means horizontal scrolling for Kanban/Gantt and a visually dense, many-`<select>` filter row. This is the area most likely to need real rework for a "students live on phones" product.

## 9. Technical constraints for whoever redesigns this

- **Stack:** React 19 + Vite, plain CSS (one file, `packages/client/src/styles.css`) — no Tailwind, no Chakra/MUI/etc., no CSS-in-JS. Any redesign should either stay in this register or the team should decide explicitly to adopt a system.
- **Theming mechanism today is exactly the 9 CSS custom properties in §4** — that's the entire "design system." A redesign can replace them wholesale; nothing else depends on their current values except literal inline `var(--x)` references scattered through the `.tsx` files (not centralized in a theme object).
- **No component library / design tokens tool** — components are hand-written function components with inline styles mixed with CSS classes; there's no Storybook or isolated component catalog to redesign against in place. (A Claude Design project could become that catalog going forward.)
- **Data model is fixed** — task/project fields, statuses-as-data, custom-field types, etc. come from `packages/shared` and must stay byte-compatible with the Obsidian plugin (`DATA_FORMAT.md`). Any UI redesign works *on top of* that model; it doesn't get to rename or restructure the underlying fields.
- **Accessibility today is baseline-only** — native form controls throughout (real `<select>`, `<input>`, `<button>`), visible focus outline on inputs/selects via `--accent`, but no ARIA beyond what's implicit in semantic HTML, no live-region announcements for the WebSocket-driven updates or mutation errors, and color is often the *only* signal (status badges, the danger-red delete button) without a paired icon or text redundancy.
- **The Discord bot's embeds are a separate surface** (Discord's own embed rendering, built in `packages/server/src/bot/content.ts`) and are out of scope for a web-app redesign — they follow Discord's own visual constraints, not this app's.

## 10. Known rough edges (flagged, not fixed)

Self-identified while building, not from user testing — treat as leads to investigate, not confirmed problems:

- Filter bar is five look-alike `<select>` elements in a row with no visual grouping or hierarchy; easy to lose track of which filters are active beyond the "Clear" button appearing.
- No onboarding/empty-state guidance beyond one muted sentence ("No projects yet." / "No tasks yet.") — nothing walks a new team through creating their first project or understanding the four roles.
- Discord role/user mapping in Settings is raw ID text fields — a real picker (showing actual role/member names from the guild) would remove real friction, and is only unbuilt because it needs a bot-side "list guild roles/members" endpoint.
- Kanban and Gantt have no mobile-specific layout — they inherit the desktop layout and scroll horizontally, which is a rough experience on a phone.
- The Sponsor role has no tailored summary view yet (scope calls for one); today Sponsors see the same Table/Kanban/Gantt as everyone else, just without edit controls.
- Status/priority colors are freehand hex with no contrast or palette guidance, so a team could pick colors that are unreadable against the fixed dark background.
- Collapse/expand state for subtasks lives in browser `localStorage`, not the user's account — it resets on a new device/browser.
- No dark/light toggle despite `color-scheme: dark` being the only theme; if the redesign wants a light mode this is a from-scratch addition, not a flip of existing tokens.

## 11. Explicitly unchanged by any UI redesign

- The task/project/vault data model and file format (`DATA_FORMAT.md`).
- The REST API shape and WebSocket event contract (`packages/server/src/app.ts`, `ws.ts`) — a redesign can restructure how the UI *calls* these, but the endpoints themselves aren't part of this handoff.
- The Discord bot's own embeds/slash-command output.
- Auth flow mechanics (Discord OAuth2 → session cookie); only its *visual* presentation (the Landing page, any future branded login state) is in scope.

## 12. Bringing changes back

This document is the baseline. Once new designs/tokens/mockups exist, hand them back with:
1. Updated design tokens (even a simple hex list mapped to the §4 names is enough to start).
2. Per-screen changes, referencing the §6 screen IDs so nothing gets lost in translation.
3. Explicit call-outs for anything that changes the **information shown**, not just its styling (e.g. adding a Sponsor summary view is a new screen, not a restyle) — those need a quick scope check against the phase plan before implementation resumes.
