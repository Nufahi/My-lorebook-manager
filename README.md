# Lorebook Manager

`Lorebook Manager` is a third-party SillyTavern extension that adds a visual manager for lorebooks / World Info files.

Current version: `0.8`

## Features

- Adds a `Manager` button inside SillyTavern's built-in World Info drawer
- Adds a lorebook cover button in the lorebook toolbar for quick cover upload, replacement, or removal
- Opens a full lorebook manager modal with search, sort, and pagination
- Supports named folders and nested subfolders for organizing lorebooks
- Includes virtual views for `All Lorebooks`, `No Folder`, and `Active Lorebooks`
- Shows card badges for `Active`, `Global`, and `No Folder` states
- Lets you create, import, open, rename, move, cover, and delete lorebooks from one place
- Allows drag-and-drop moving of lorebooks onto folders in the sidebar
- Tracks active lorebooks for the current solo or group chat context

## Images

![image](https://i.imgur.com/ANDlGoh.png)
![image](https://i.imgur.com/fs1Yw4A.png)

## Active Lorebooks

The `Active Lorebooks` view is chat-aware and is meant to show which lorebooks are currently attached to the active chat context.

This currently includes:

- Globally selected lorebooks
- The chat-bound lorebook
- The active solo character's lorebooks
- Group members' lorebooks in group chats

This is a lorebook-level view, not a per-entry activation viewer.

## How It Stores Data

- Folder tree state is stored in SillyTavern extension settings under `lorebookManager`
- Per-lorebook manager data is stored inside each lorebook JSON under:

```json
{
  "extensions": {
    "lorebook_manager": {
      "bookId": "uuid",
      "folderId": "uuid",
      "coverPath": "user/images/lorebook-manager/example-cover.png"
    }
  }
}
```

This keeps folder assignment and cover data attached to the lorebook instead of using a separate sidecar file.

## Install

Install it through SillyTavern's built-in extension installer from the repository URL:

```text
https://github.com/ayvencore/SillyTavern-Lorebook-Manager
```

## Notes

- Cover images are uploaded through SillyTavern's normal user image storage
- Renaming from the manager uses SillyTavern's built-in rename flow so it behaves like the core lorebook editor
- Folder assignment and cover images persist on each lorebook through the `extensions.lorebook_manager` field

## Disclaimers

- This is my first full extension, and it was vibe coded!
- It hasn't been tested on mobile yet
- Thank you to my friend Fae for the "Active Lorebooks" idea
- Feedback, contributions, and forks are welcomed!
