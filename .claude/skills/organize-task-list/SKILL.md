---
name: organize-task-list
description: Reorganize a flat Athena task list into main tasks with related items nested as subtasks. Use when the user pastes a task/todo list and asks to organize it, group related tasks, clean up a todo list, or add structure to a flat list of items.
---

Athena's plain-text todo format (`client/src/todoTransfer.ts`) is how a list round-trips as text:

```
# List title (general|daily)
> optional note, one line per '>'
- [ ] Task text !2 @2026-07-28 ~daily+interval
  - [x] Subtask text
```

Rules of the format:
- `- [ ]` / `- [x]` marks not-done / done.
- Trailing tokens, any order, all optional: `!1`/`!2`/`!3` priority, `@YYYY-MM-DD` due date, `~daily|weekly|monthly[+interval]` recurrence.
- Two-space indent nests an item as a subtask of the item directly above it. **Nesting is exactly one level deep**: a subtask can never itself have subtasks.

## Steps

1. **Parse** the input into list headers (with their kind and notes) and a flat sequence of items, each keeping its done-state and trailing tokens exactly as given. If an item is already indented under another (an existing subtask), keep that pairing locked. It cannot be re-grouped, since a subtask can't gain its own children.

2. **Group by real relationship**, not superficial word overlap. A group is items that belong to the same concrete project, feature, or effort, not just items that share a noun. When in doubt, a grouping should be one you could justify with a one-sentence reason ("these are all Roblox engine/content work," "these are all Athena app-maintenance bugs"). Don't force a group smaller than two items: a single item with no real sibling stays at the top level.

3. **Nest.** For each group of 2+ items, pick or write one main-task line that names the group, and place the group's items beneath it as subtasks (two-space indent). An item that already owns subtasks of its own stays at the top level and keeps its existing children untouched. It cannot become someone else's subtask.

4. **Preserve everything.** Every original item must appear exactly once in the output, with its original text, done-state, and trailing tokens unchanged. Never invent a priority, date, or recurrence that wasn't in the input. Never drop or duplicate an item. List headers, kind, and notes carry over unchanged.

5. **Output** the result in the same plain-text format, ready to paste back into Athena. After producing it, briefly state which groups were formed and why, and name any items left ungrouped.

Completion criterion: a diff between input items and output items (ignoring order and indentation) is empty (same items, same done-states, same tokens), and every group of 2+ nested items shares a stated, concrete reason for being together.
