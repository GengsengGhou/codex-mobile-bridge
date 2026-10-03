# Workspace upload storage

Uploads normally live in `<conversation cwd>/mobile-uploads/<UUID>/<name>`.
The conversation cwd, local host and thread identity continue to determine access.

When a cwd is a container for several software projects, an administrator can put
`upload-locations.json` beside the connector's private `.local/uploads.json`:

```json
{
  "version": 1,
  "locations": [
    {
      "cwd": "D:\\Projects",
      "directory": "bridge-project/mobile-uploads"
    }
  ]
}
```

Use a normalized absolute cwd and a relative directory with forward slashes. The
directory must end in `mobile-uploads`, remain inside that cwd and contain no
hidden, reserved, credential-like or traversal segments. The file is trusted local
configuration; there is no browser endpoint for editing it. A missing config keeps
the usual behavior; an invalid config fails closed before reserving a new upload.
The Windows installer preserves `.local/` on upgrade and excludes private data,
uploads and local verification artifacts from release packages.

Each newly reserved upload records its physical `storagePath`. Changing the local
config affects future IDs only. Existing IDs retain their location, workspace,
thread, filename, directory inode and SHA-256 checks. Every storage ancestor is
checked for symbolic links or junctions. No path outside the conversation cwd is
allowed.

The receipt's `path` remains `mobile-uploads/<UUID>/<name>` for compatibility.
Relocated receipts additionally supply `workspacePath`, the physical path relative
to the unchanged cwd, and an `absolutePath` for the attachment message. The browser
validates all three paths and rechecks ready receipts before dispatch. Existing
browser recovery records refresh their absolute paths when they next check the ID;
a page already open during a local software update needs a reload to load the new
receipt validator.

Moving existing files requires stopping the owned connector and bridge, backing
up every ledger, rejecting links and destination conflicts, verifying every file's
hash and matching each tracked directory's inode. Update each affected ledger's
`storagePath` and receipt paths while retaining its original cwd and thread ID.
Keep untracked files and empty directories too. A same-volume directory rename
preserves identity; do not silently replace the recorded inode after a copy.
Restart the local services and verify lookup, retry and file preview afterwards.

The file API recognizes exact historical `mobile-uploads/<UUID>/<name>` paths,
including old absolute links and line suffixes, only when their ledger belongs to
that thread and the relocated file passes the normal identity and hash checks.
The subsequent file read still applies workspace confinement and file policies.
Other paths follow the ordinary file reader. This does not rewrite Codex history
or change its database. External programs following the former absolute path
directly must use the new location; no root-level junction or shortcut is created.
