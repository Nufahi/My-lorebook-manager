# My Lorebook Manager

A heavily enhanced fork of [SillyTavern-Lorebook-Manager](https://github.com/ayvencore/SillyTavern-Lorebook-Manager) — a visual manager for lorebooks / World Info files in SillyTavern.

Current version: `0.9.0`

## What's Different From the Original

The original extension by **[ayvencore](https://github.com/ayvencore)** provides a solid foundation: a visual lorebook manager modal with folder organization, cover images, search/sort/pagination, and active lorebook tracking. This fork keeps all of that and adds a bunch of new features on top, plus a full mobile-first responsive redesign.

## Features

### From the Original
- Manager button inside SillyTavern's World Info drawer
- Lorebook cover upload, replacement, and removal
- Full manager modal with search, sort, and pagination
- Named folders and nested subfolders
- Virtual views: All Lorebooks, No Folder, Active Lorebooks
- Card badges for Active, Global, and No Folder states
- Create, import, open, rename, move, cover, and delete lorebooks
- Drag-and-drop lorebooks onto sidebar folders
- Active lorebook tracking for solo and group chat contexts

### New in This Fork
- **Multi-Select Mode** — select multiple lorebooks with checkboxes and perform bulk actions (delete, move to folder)
- **Quick Activate/Deactivate** — toggle lorebook active state directly from the card without opening it
- **Tag System** — create, assign, and filter lorebooks by custom tags; tags show as chips on cards
- **Statistics Popup** — view detailed stats for any lorebook (entries, tokens, keywords, file size, and more)
- **Entry Count Display** — each card shows the number of entries in the lorebook
- **Mobile-First Responsive UI** — fully redesigned layout for phones and tablets: horizontal card layout, collapsible sidebar, compact toolbar, touch-friendly controls

## Screenshots

### Desktop — Full Manager View
The main interface with card grid, sidebar folders, tags, and lorebook covers.

![Desktop View](images/desktop-view.jpg)

### Sidebar — Folders & Tags
Folder tree with virtual views (All / No Folder / Active), custom folders, and a dedicated Tags section for filtering.

![Sidebar](images/sidebar.jpg)

### Card Actions
Each lorebook card has quick actions: activate/deactivate, open, folder assignment, and a tool row for cover, stats, tags, rename, and delete.

![Card Actions](images/card-actions.jpg)

### Tag Editor
Assign existing tags or create new ones per lorebook. Tags appear as chips on cards and as filters in the sidebar.

![Tag Editor](images/tag-editor.jpg)

### Statistics Popup
Detailed breakdown for each lorebook: entry count, enabled/disabled/constant entries, estimated tokens, keywords, file size, folder, tags, and character count.

![Statistics](images/stats.jpg)

## Active Lorebooks

The Active Lorebooks view is chat-aware and shows which lorebooks are currently attached to the active chat context:

- Globally selected lorebooks
- The chat-bound lorebook
- The active solo character's lorebooks
- Group members' lorebooks in group chats

This is a lorebook-level view, not a per-entry activation viewer.

## How It Stores Data

- Folder tree and tag definitions are stored in SillyTavern extension settings under `lorebookManager`
- Per-lorebook data is stored inside each lorebook JSON under:

```json
{
  "extensions": {
    "lorebook_manager": {
      "bookId": "uuid",
      "folderId": "uuid",
      "coverPath": "user/images/lorebook-manager/example-cover.png",
      "tags": ["tag1", "tag2"]
    }
  }
}
```

## Install

Install through SillyTavern's built-in extension installer:

```text
https://github.com/Nufahi/My-lorebook-manager
```

## Credits

- **Original Extension** — [ayvencore](https://github.com/ayvencore) • [SillyTavern-Lorebook-Manager](https://github.com/ayvencore/SillyTavern-Lorebook-Manager)
  The original codebase that this fork is built on. All core functionality (manager modal, folder system, covers, drag-and-drop, active lorebook tracking) comes from ayvencore's work.
- **This Fork** — [Codex](https://github.com/Nufahi)
  Multi-select, tags, statistics, activate/deactivate toggle, mobile responsive UI, and various QoL improvements.
- **"Active Lorebooks" idea** — Fae (credited in the original)

## Notes

- Cover images are uploaded through SillyTavern's normal user image storage
- Renaming uses SillyTavern's built-in rename flow
- Folder assignment, cover images, and tags persist on each lorebook through the `extensions.lorebook_manager` field
- Tested and optimized for mobile (Android/iOS via browser)

## License

This is a fork of an open-source project. All original code belongs to its respective author. Contributions and forks are welcome!
