# My Lorebook Manager

A heavily enhanced fork of [SillyTavern-Lorebook-Manager](https://github.com/ayvencore/SillyTavern-Lorebook-Manager) — a visual manager for lorebooks / World Info files in SillyTavern.

Current version: `0.9.0`

## Credits

- **Original Extension** — [ayvencore](https://github.com/ayvencore) • [SillyTavern-Lorebook-Manager](https://github.com/ayvencore/SillyTavern-Lorebook-Manager)
  The original codebase that this fork is built on. All core functionality (manager modal, folder system, covers, drag-and-drop, active lorebook tracking) comes from ayvencore's work.
- **This Fork** — [Codex](https://github.com/Nufahi)
  Multi-select, tags, statistics, activate/deactivate toggle, mobile responsive UI, and various QoL improvements.
- **"Active Lorebooks" idea** — Fae (credited in the original)

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

<img width="1348" height="850" alt="image_2026-03-16_17-20-42" src="https://github.com/user-attachments/assets/a5451bab-ab9f-42e2-a78a-69689285dd56" />

### Sidebar — Folders & Tags
Folder tree with virtual views (All / No Folder / Active), custom folders, and a dedicated Tags section for filtering.

<img width="328" height="471" alt="image_2026-03-16_17-20-42 (5)" src="https://github.com/user-attachments/assets/5c7eb3c0-f3ff-4430-8c8a-a4fa91c319fd" />

### Card Actions
Each lorebook card has quick actions: activate/deactivate, open, folder assignment, and a tool row for cover, stats, tags, rename, and delete.

<img width="222" height="231" alt="image_2026-03-16_17-20-42 (4)" src="https://github.com/user-attachments/assets/290b3374-2a4d-4726-8759-8981442a6237" />

### Tag Editor
Assign existing tags or create new ones per lorebook. Tags appear as chips on cards and as filters in the sidebar.

<img width="528" height="266" alt="image_2026-03-16_17-20-42 (3)" src="https://github.com/user-attachments/assets/eee2a47e-8786-451b-a2a4-7a23ac59795b" />

### Statistics Popup
Detailed breakdown for each lorebook: entry count, enabled/disabled/constant entries, estimated tokens, keywords, file size, folder, tags, and character count.

<img width="534" height="476" alt="image_2026-03-16_17-20-42 (2)" src="https://github.com/user-attachments/assets/9e34ad09-c3db-4c8c-87e2-a57ffefc830b" />

## Install

Install through SillyTavern's built-in extension installer:

```text
https://github.com/Nufahi/My-lorebook-manager
```

## Active Lorebooks

The Active Lorebooks view is chat-aware and shows which lorebooks are currently attached to the active chat context:

- Globally selected lorebooks
- The chat-bound lorebook
- The active solo character's lorebooks
- Group members' lorebooks in group chats

This is a lorebook-level view, not a per-entry activation viewer.

## Notes

- Cover images are uploaded through SillyTavern's normal user image storage
- Renaming uses SillyTavern's built-in rename flow
- Folder assignment, cover images, and tags persist on each lorebook through the `extensions.lorebook_manager` field
- Tested and optimized for mobile (Android/iOS via browser)

## License

This project is a derivative work based on
[SillyTavern-Lorebook-Manager](https://github.com/ayvencore/SillyTavern-Lorebook-Manager)
by ayvencore, licensed under the
[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html).

This fork is distributed under the same AGPL-3.0 license.
See [LICENSE](./LICENSE) for the full text.
