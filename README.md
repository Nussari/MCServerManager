# Minecraft Server Manager

A web dashboard for managing multiple Minecraft servers. Create servers from templates, start/stop them, and interact with the console in real-time — all from your browser.

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
├── templates/                    # Server templates + common defaults
│   └── common/                   # Shared defaults (eula, properties, icon)
├── Dockerfile
└── package.json
```

## Prerequisites

- **Node.js 20+**
- **Java 21+** (for running Minecraft servers)
- At least one template with a server jar

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

**Standard mode** (vanilla, Paper, etc.) — the service prepends `-Xms`/`-Xmx` RAM flags:
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
  --stop-timeout 60 \
  mc-manager
```

The `--stop-timeout 60` gives Minecraft servers time to save worlds on shutdown.

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
| `DEFAULT_JAVA` | `java` | Path to Java binary |
| `DEFAULT_MIN_RAM` | `1024M` | Default -Xms for new servers |
| `DEFAULT_MAX_RAM` | `1024M` | Default -Xmx for new servers |
| `CONSOLE_BUFFER_SIZE` | `500` | Lines of console output buffered per server |
| `STOP_TIMEOUT_MS` | `30000` | Milliseconds to wait for graceful stop before force-killing |
| `BASE_MC_PORT` | `25565` | Starting port for auto-assignment |

## How It Works

- **Process management**: Each Minecraft server runs as a child process of the Node.js service. Stdin is piped for commands, stdout/stderr are captured for the console.
- **Communication**: Real-time events use Socket.IO (WebSocket). Template ZIP uploads use an HTTP POST endpoint (`/api/upload-template`) to support large files with streaming and progress tracking.
- **Persistence**: Server registry is stored in `data/servers.json`. On service restart, all servers start in "stopped" state — you decide what to start.
- **Graceful shutdown**: On SIGTERM/SIGINT, the service sends `stop` to all running Minecraft servers and waits for them to save before exiting.

## Socket.IO Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `list-servers` | — | Get all servers (callback) |
| `list-templates` | — | Get available templates (callback) |
| `create-server` | `{ name, templateName, port?, motd?, maxPlayers?, gamemode?, difficulty?, hardcore?, minRam?, maxRam?, pvp?, viewDistance?, simulationDistance?, whitelist? }` | Create server (callback) |
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

### HTTP Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/upload-template?name=<name>` | Raw ZIP binary | Upload template ZIP (streams to disk). Returns `{ ok, files }`. |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `server-created` | `serverInfo` | New server created |
| `server-deleted` | `{ serverId }` | Server deleted |
| `server-updated` | `serverInfo` | Server status changed |
| `output` | `{ line, stream, timestamp }` | Console output line |
| `output-history` | `[{ line, stream, timestamp }, ...]` | Buffered output on join |
| `status-change` | `serverInfo` | Server info updated |
