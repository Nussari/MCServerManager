# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm start            # Start the service (http://localhost:3000)
npm run dev          # Start with auto-restart on file changes (Node --watch)
docker build -t mc-manager .   # Build container image
```

No test framework is configured. No linter is configured.

## Architecture

This is a Minecraft server management web service. Node.js spawns Minecraft servers as child processes, pipes stdin for commands, captures stdout/stderr for real-time console streaming via Socket.IO. No REST API — all communication is Socket.IO events.

**Key data flow:** Browser ↔ Socket.IO ↔ `index.js` ↔ `ServerManager` ↔ `MinecraftServer` ↔ Java child process (stdin/stdout). Template ZIP uploads use HTTP POST (`/api/upload-template`) instead of Socket.IO to support large files with streaming and progress tracking.

### Backend

- **`src/index.js`** — Entry point. Wires Express (static files only), Socket.IO event handlers, and graceful shutdown (SIGTERM/SIGINT stops all running MC servers before exit).
- **`src/services/MinecraftServer.js`** — EventEmitter wrapping a single MC server process. Manages lifecycle state machine (`stopped→starting→running→stopping→stopped` or `crashed`). Uses a ring buffer for console output. Exports `STATUS` constants — always use these instead of string literals for server status.
- **`src/services/ServerManager.js`** — Singleton orchestrator. CRUD for servers, template copying, port auto-assignment, JSON file persistence (`data/servers.json`), server settings edit, template upload (zip extraction from file via adm-zip), server icon resize (via sharp). Forwards MinecraftServer events with `server:` prefix for Socket.IO layer.
- **`src/utils/config.js`** — All configuration via env vars. Creates runtime directories (`servers/`, `templates/`, `data/`) on import.
- **`src/utils/properties.js`** — Round-trip parser/writer for Java `.properties` files (Minecraft's `server.properties`). Preserves comments and ordering.

### Frontend

Vanilla HTML/CSS/JS with Socket.IO client. No build step.

- **`public/js/utils.js`** — Shared utilities (loaded before other scripts via `<script>` tag).
- **`public/js/dashboard.js`** — Server card grid, add-server modal, template upload modal. Joins `dashboard` Socket.IO room for live status updates.
- **`public/js/console.js`** — Real-time terminal console, edit server modal. Joins `server:{id}` Socket.IO room. Auto-scroll with scroll-lock detection.

### Process Management

- Each MC server is a `child_process.spawn()` with `stdio: ['pipe', 'pipe', 'pipe']`.
- Commands sent via `process.stdin.write()`. Output read via `readline` on stdout/stderr.
- On service restart, all servers are marked `stopped` — no auto-restart, no PID reattachment.
- `stop()` sends the `stop` command to stdin, waits up to `STOP_TIMEOUT_MS`, then SIGKILL.

### Templates

`templates/common/` holds shared defaults (eula.txt, server.properties, server-icon.png) copied to every new server first. Template directories overlay on top — template files override common files. Templates can be uploaded via the GUI (zip upload) or placed manually. A `template.json` stores the `startArgs` array: `["-jar", "server.jar", "nogui"]` for standard servers, or `["@user_jvm_args.txt", "@libraries/.../unix_args.txt"]` for modded. In jar mode (`-jar` first arg), the service prepends RAM flags. In custom args mode, the args files manage JVM settings. JVM flags are minimal — G1GC with Docker-safe defaults only, no Aikar overrides. Extra flags can be added via `DEFAULT_JVM_FLAGS` env var.

## Workflow Rules

- **Always keep `README.md` up to date** when changing features, configuration, events, or project structure.
- **Always review code after writing** to check for edge case breakage and potential memory leaks (unbounded buffers, unremoved event listeners, unclosed handles).

## Key Conventions

- Use `STATUS` constants from `MinecraftServer.js` for server status checks — never raw strings on the backend.
- `playerCount` is a derived getter (`players.size`), not stored state.
- All Socket.IO event handlers use callbacks for request/response pattern: `callback({ ok: true, ... })` or `callback({ ok: false, error: '...' })`.
- Persistence is synchronous JSON writes (`servers.json`) — intentional for single-process safety.
- Validate RAM values match `/^\d+[MG]$/` before passing to spawn arguments.
- Validate path inputs (serverJar, template names) to prevent path traversal.
- Developed on Windows, deployed in Linux containers. Use `path.join()` everywhere, never hardcode separators.
- For modal/overlay backdrop dismissal, listen for the `backdrop-dismiss` custom event (`overlay.addEventListener('backdrop-dismiss', closeFn)`). The delegation is installed once in `public/js/utils.js` for every `.modal-overlay`. Never use `overlay.onclick` or a `'click'` listener that checks `e.target === overlay` — `click` fires on the common ancestor of mousedown/mouseup, so a drag-select that ends on the backdrop would falsely dismiss the modal.
