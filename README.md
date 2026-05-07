# Minecraft Server Manager

A web dashboard for managing multiple Minecraft servers. Create servers from templates, import existing servers, start/stop them, and interact with the console in real-time, all from your browser.

## Project Structure

```
serverService/
├── src/
│   ├── index.js                  # Entry point (Express static + Socket.IO)
│   ├── services/
│   │   ├── MinecraftServer.js    # Wraps a single MC server process
│   │   └── ServerManager.js      # Orchestrates all servers (CRUD, persistence)
│   └── utils/
│       ├── config.js             # Environment-based configuration
│       ├── javaDetect.js         # Auto-detect required Java version from JAR
│       ├── mojang.js             # Mojang API client (version manifest + JAR download)
│       └── properties.js         # server.properties file parser/writer
├── public/                       # Frontend (vanilla HTML/CSS/JS)
│   ├── index.html                # Dashboard
│   ├── server.html               # Server console page
│   ├── css/style.css
│   └── js/
│       ├── utils.js
│       ├── dashboard.js
│       └── console.js
├── data/                         # Runtime: server registry (servers.json)
├── servers/                      # Runtime: MC server instance directories
├── backups/                      # Runtime: world backups (one zip per server)
├── templates/                    # Server templates + common defaults
│   └── common/                   # Shared defaults (eula, properties, icon)
├── Dockerfile
└── package.json
```

## Prerequisites

- **Node.js 20+**
- **Java 21+** (for running Minecraft servers; the Docker image bundles JDK 21 and 25)
- At least one template with a server jar, or use the built-in "Latest Release" option to auto-download

## Quick Start

```bash
# Install dependencies
npm install

# Create a template (example: vanilla)
mkdir -p templates/vanilla
# Download server.jar from https://www.minecraft.net/en-us/download/server
# and place it in templates/vanilla/

# Start the service
npm start
```

Open http://localhost:3000 in your browser.

## Latest Release (Auto-Download)

When creating a server, select **"Latest Release (Vanilla)"** from the template dropdown. The service fetches the current release version from Mojang's API, downloads the server JAR (~60MB) with SHA1 verification, and creates the server automatically. A progress bar shows download status.

Downloaded versions are cached as `Vanilla-{version}` template directories (e.g., `templates/Vanilla-26.1.1/`). Subsequent servers using the same version skip the download. These cached templates are hidden from the regular template dropdown — they are only accessible through the "Latest Release" option.

The server's template name is displayed as `Vanilla-{version}` (e.g., `Vanilla-26.1.1`).

## Templates

Templates live in the `templates/` directory. Each template is a folder containing at minimum a server jar file (usually `server.jar`).

### Common Defaults

The `templates/common/` folder contains shared files that are copied to every new server before the template overlay. Place default `eula.txt`, `server.properties`, and `server-icon.png` here. Template-specific files override common files.

### Template Structure

| File | Required | Purpose |
|------|----------|---------|
| `server.jar` (or custom name) | Depends | The Minecraft server JAR (required for standard mode) |
| `template.json` | No | Launch config — see below |
| `eula.txt` | No | Falls back to `common/eula.txt` |
| `server.properties` | No | Falls back to `common/server.properties` |

Any additional files in the template (plugins, configs, etc.) are copied to the new server instance.

### Launch Modes

`template.json` controls how the server is launched:

**Standard mode** (vanilla, Paper, etc.) — the service prepends RAM flags (`-Xms` is set equal to `-Xmx` to avoid heap resize pauses):
```json
{ "startArgs": ["-jar", "server.jar", "nogui"] }
```

**Custom args mode** (NeoForge, Fabric, etc.) — the service passes args as-is, RAM is managed by the args files:
```json
{ "startArgs": ["@user_jvm_args.txt", "@libraries/net/neoforged/neoforge/21.1.219/unix_args.txt"] }
```

If no `template.json` exists, defaults to standard mode with `server.jar`.

### Uploading Templates via GUI

Click "Add Template" on the dashboard to upload a ZIP file. After upload, either select a `.jar` file for standard mode, or enter custom Java arguments for modded servers (e.g. NeoForge). The `template.json` is created automatically.

### Managing Templates via GUI

Click "View Templates" on the dashboard to see all available templates with their readiness status. From this view you can delete any template. Deleting a template does not affect servers already created from it.

## Importing Existing Servers

Click "Import Server" on the dashboard to import an existing Minecraft server from a ZIP file. This creates a server instance directly from your existing server files — preserving world data, mods, plugins, and configuration.

**How it works:**
1. Enter a server name and upload a ZIP of your server directory
2. The service scans the ZIP for `.jar` files, reads `server.properties` for settings, and detects modded server indicators (NeoForge/Fabric args files)
3. Select the server JAR or enter custom Java arguments for modded servers
4. Optionally adjust the detected port, RAM, and server name in the advanced settings
5. Click "Import Server" to finalize — the server appears on your dashboard ready to start

**Notes:**
- If your ZIP has a single nested root folder, it is automatically unwrapped
- If `eula.txt` is missing or not accepted, it is automatically created
- Imported servers show `(imported)` as their template name
- The detected `server-port` from `server.properties` is pre-filled but can be overridden

### Example templates

- **vanilla/** — Official Minecraft server
- **paper/** — PaperMC (performance-optimized)
- **forge/** — Minecraft Forge (modded)

## Server Settings

When creating or editing a server, you can configure:

**Basic:**
- Server name, MOTD, difficulty, gamemode, hardcore mode

**Advanced:**
- Max RAM (1-8 GB), PVP, port, max players, view distance, simulation distance, whitelist

**Server Icon:**
- Upload a custom image — it will be automatically resized to 64x64 PNG

Settings can be changed after creation via the Edit button on the server detail page. Property changes require a server restart to take effect.

## Updating Server Files

The server detail page has a **Files** menu (top-right of the action bar) with these options:

- **Mods** — manage the server's `mods/` directory (jars only).
- **Update** — drop new files or folders into the server directory, replacing whatever is already there.
- **Download World** — zips the world dirs and streams the archive to your browser.
- **Backup World** / **Restore World** — see [World Backups](#world-backups) below.

The Update modal accepts:

- **Individual files or folders** dragged onto the drop zone (or picked via the buttons). Folder structure is preserved — drop `mods/` and `config/` and they land at the right places. Each file is uploaded individually with a progress bar.
- **A single ZIP archive** — auto-detected when exactly one `.zip` is staged. The whole archive uploads in one request and is extracted server-side. This is much faster than per-file uploads for modded servers (e.g. NeoForge `libraries/` trees with thousands of small files).

**Optional extras in the same modal:**

- **Edit start arguments** — collapsible section pre-filled with the server's current `startArgs` (one per line). Useful when bumping a NeoForge version that ships a new `unix_args.txt` path. Only the per-server config is changed; the originating template is left alone.
- **Back up world before update** — runs the world backup pipeline (see below) before any files are touched.

**Rules:**

- The server must be stopped. Updates are blocked while the server is running, starting, or stopping.
- Conflicts always overwrite — the new file wins. Old files that aren't in your upload are left in place; if you need to remove them use the Mods modal or delete them out-of-band.
- Paths are validated server-side: leading separators, drive letters, and `..` segments are rejected, and every resolved path must stay inside the server directory.

## World Backups

The server detail page's **Files** dropdown contains **Backup World**, **Restore World**, and **Download World**, plus a small footer line showing the current backup's size and timestamp (or "No backup").

- **Backup World** creates a ZIP of the world data on the server host. Only world folders are included (the `level-name` dir plus any `{level-name}_nether` / `{level-name}_the_end` dims) — not mods, configs, or server jars.
- **Restore World** replaces the current world with the stored backup. Disabled when no backup exists.
- **Download World** zips the world dirs and streams the archive to your browser, leaving the stored backup untouched. Use this to grab a copy of the world without overwriting the server-side backup slot.

**Rules:**
- The server must be stopped before backing up, restoring, or downloading the world (ensures a consistent save).
- Each server has at most one stored backup. Running a new backup overwrites the previous one — the UI asks for confirmation first.
- Restore only replaces the folders present in the backup ZIP; unrelated server files are left untouched.
- Stored backups live in `backups/{serverId}.zip` and are deleted when the server is deleted. Download archives are written to a temp file, streamed to the browser, then removed.

## Docker

```bash
# Build
docker build -t mc-manager .

# Run
docker run -d \
  --name mc-manager \
  -p 3000:3000 \
  -p 25565-25575:25565-25575 \
  -v mc-data:/app/data \
  -v mc-servers:/app/servers \
  -v mc-templates:/app/templates \
  -v mc-backups:/app/backups \
  --stop-timeout 60 \
  mc-manager
```

The `--stop-timeout 60` gives Minecraft servers time to save worlds on shutdown.

**Docker host tuning** (run on the host, not in the container):

```bash
# Increase mmap limit — Java uses many memory-mapped regions. Default (65530) is too low for large heaps.
sudo sysctl -w vm.max_map_count=2147483642

# Make it persist across reboots
echo 'vm.max_map_count=2147483642' | sudo tee -a /etc/sysctl.conf
```

**Memory headroom**: The container needs ~25-30% more RAM than the Java heap (`-Xmx`). For an 8G heap, give the container at least 10G. The extra is used by metaspace, thread stacks, code cache, and GC overhead. If using `--memory`, set it accordingly.

Place your templates in the `mc-templates` volume. You can copy files into a Docker volume with:

```bash
docker cp ./my-template mc-manager:/app/templates/my-template
```

## Configuration

All settings are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web UI port |
| `SERVERS_DIR` | `./servers` | Where server instances are stored |
| `TEMPLATES_DIR` | `./templates` | Where templates live |
| `DATA_DIR` | `./data` | Where servers.json is stored |
| `BACKUPS_DIR` | `./backups` | Where world backups are stored |
| `DEFAULT_JAVA` | `java` | Path to Java binary (fallback when auto-detect is unavailable) |
| `JAVA_<version>` | — | Path to a specific Java version (e.g. `JAVA_21=/opt/java/21/bin/java`). Used by auto-detection to pick the right JDK for each server JAR |
| `DEFAULT_MIN_RAM` | `1024M` | Default min RAM for new servers (note: `-Xms` is set equal to `-Xmx` at launch to avoid heap resize pauses) |
| `DEFAULT_MAX_RAM` | `6G` | Default -Xmx (and -Xms) for new servers |
| `CONSOLE_BUFFER_SIZE` | `500` | Lines of console output buffered per server |
| `STOP_TIMEOUT_MS` | `30000` | Milliseconds to wait for graceful stop before force-killing |
| `BASE_MC_PORT` | `25565` | Starting port for auto-assignment |
| `DEFAULT_JVM_FLAGS` | — | Extra JVM flags appended after the base G1GC flags for all servers. Applied last, so they override defaults |

## How It Works

- **Java auto-detection**: On start, the service reads the class file version from the server JAR's main class and selects the best matching JDK from the configured `JAVA_<version>` paths. G1GC is used with minimal, clean flags — JDK 21's G1 defaults are well-tuned out of the box. Performance data and core dumps are disabled for Docker compatibility. Extra JVM flags can be added via the `DEFAULT_JVM_FLAGS` env var.
- **Process management**: Each Minecraft server runs as a child process of the Node.js service. Stdin is piped for commands, stdout/stderr are captured for the console.
- **Communication**: Real-time events use Socket.IO (WebSocket). File uploads (template ZIPs, server import ZIPs, mod jars, server updates) use HTTP POST endpoints (`/api/upload-template`, `/api/import-server`, `/api/upload-mods`, `/api/update-server-file`, `/api/update-server-zip`) to support large files with streaming and progress tracking.
- **Persistence**: Server registry is stored in `data/servers.json`. On service restart, all servers start in "stopped" state — you decide what to start.
- **Graceful shutdown**: On SIGTERM/SIGINT, the service sends `stop` to all running Minecraft servers and waits for them to save before exiting.

## Socket.IO Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `list-servers` | — | Get all servers (callback) |
| `list-templates` | — | Get available templates (callback) |
| `fetch-latest-release` | — | Get latest Minecraft version info from Mojang API (callback: `{ version, jarUrl, sha1, templateName, cached }`) |
| `create-server` | `{ name, templateName, port?, motd?, maxPlayers?, gamemode?, difficulty?, hardcore?, minRam?, maxRam?, pvp?, viewDistance?, simulationDistance?, whitelist?, _latestRelease? }` | Create server (callback). If `_latestRelease` is present, downloads JAR first |
| `delete-server` | `{ serverId }` | Delete server (callback) |
| `start-server` | `{ serverId }` | Start server (callback) |
| `stop-server` | `{ serverId }` | Stop server (callback) |
| `send-command` | `{ serverId, command }` | Send command to stdin |
| `join-server` | `{ serverId }` | Subscribe to console output |
| `leave-server` | `{ serverId }` | Unsubscribe from console output |
| `join-dashboard` | — | Subscribe to status updates |
| `get-server-settings` | `{ serverId }` | Get server properties for editing (callback) |
| `update-server` | `{ serverId, name?, motd?, difficulty?, ... }` | Update server settings (callback) |
| `upload-server-icon` | `{ serverId, imageData: ArrayBuffer }` | Upload custom 64x64 server icon |
| `finalize-template` | `{ name, serverJar }` | Confirm template with chosen server jar |
| `cancel-template-upload` | `{ name }` | Cancel pending template upload |
| `delete-template` | `{ name }` | Delete a template directory (callback) |
| `finalize-import` | `{ importId, name, serverJar?, customArgs?, port?, minRam?, maxRam? }` | Confirm server import with chosen jar/args |
| `cancel-import` | `{ importId }` | Cancel pending server import |
| `get-server-startargs` | `{ serverId }` | Get the server's current `startArgs` array (callback: `{ ok, startArgs }`) |
| `set-server-startargs` | `{ serverId, startArgs: string[] }` | Replace the server's `startArgs`; server must be stopped, jar mode validates the jar exists (callback: `{ ok, server }`) |
| `has-backup` | `{ serverId }` | Check if a world backup exists (callback: `{ ok, exists }`) |
| `backup-server` | `{ serverId }` | Create/overwrite the world backup; server must be stopped (callback: `{ ok, size, createdAt }`) |
| `restore-backup` | `{ serverId }` | Replace the world folders with the stored backup; server must be stopped (callback: `{ ok }`) |
| `check-world-download` | `{ serverId }` | Validate that the world can be downloaded (server stopped + world exists). Used as a precheck before navigating to `/api/download-world` (callback: `{ ok, levelName, serverName }`) |

### HTTP Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/upload-template?name=<name>` | Raw ZIP binary | Upload template ZIP (streams to disk). Returns `{ ok, files }`. |
| `POST` | `/api/import-server?name=<name>` | Raw ZIP binary | Upload server ZIP for import (streams to disk). Returns `{ ok, importId, jarFiles, detectedSettings, hasEula, moddedHint }`. |
| `POST` | `/api/update-server-file?id=<serverId>&relpath=<path>` | Raw file binary | Stream a single file into the server directory at `relpath`, overwriting on conflict. Server must be stopped. Returns `{ ok, overwritten }`. |
| `POST` | `/api/update-server-zip?id=<serverId>` | Raw ZIP binary | Stream a ZIP, extract into the server directory, overwriting on conflict. Server must be stopped. Returns `{ ok, added, overwritten }`. |
| `GET` | `/api/download-world?id=<serverId>` | — | Build a ZIP of the server's world dirs and stream it as an attachment. Server must be stopped. Returns `400 { ok: false, error }` on failure. Run `check-world-download` first to surface friendly errors. |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `server-created` | `serverInfo` | New server created |
| `server-deleted` | `{ serverId }` | Server deleted |
| `server-updated` | `serverInfo` | Server status changed |
| `output` | `{ line, stream, timestamp }` | Console output line |
| `output-history` | `[{ line, stream, timestamp }, ...]` | Buffered output on join |
| `status-change` | `serverInfo` | Server info updated |
| `download-progress` | `{ downloaded, total }` | JAR download progress (sent to requesting socket only) |
