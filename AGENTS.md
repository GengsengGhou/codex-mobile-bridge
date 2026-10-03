# Project workspace layout

- Treat this repository directory as the project root. Run development and verification commands with this directory as their working directory.
- Put local verification scripts, screenshots, logs, and evidence in this project's ignored `work/` directory, or use the operating system's temporary directory for disposable files.
- Resolve generated output paths against the project root or the script's own location. Do not create `work/`, upload storage, or other runtime directories next to sibling software projects.
- Preserve uploaded files and their durable records when changing storage locations. Keep workspace ownership, thread ownership, file hashes, and link checks intact.
- Keep machine-specific upload configuration and private state in `.local/`; exclude them and uploaded files from Git and release packages.
- Historical attachment messages can contain an old absolute path after a storage migration. If that path is missing, consult the private upload record for the same upload ID, filename, and thread to find its recorded `storagePath`; do not rewrite conversation history or create a directory link alongside the projects.
