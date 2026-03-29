const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const config = require('../utils/config');
const properties = require('../utils/properties');
const { MinecraftServer, STATUS } = require('./MinecraftServer');

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map();
    this.dataFile = path.join(config.DATA_DIR, 'servers.json');
  }

  init() {
    let entries = [];
    if (fs.existsSync(this.dataFile)) {
      try {
        entries = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
      } catch (err) {
        console.error('Failed to parse servers.json, starting fresh:', err.message);
      }
    }

    // Clean up any leftover temp upload directories
    for (const d of fs.readdirSync(config.TEMPLATES_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && d.name.startsWith('_uploading_')) {
        fs.rmSync(path.join(config.TEMPLATES_DIR, d.name), { recursive: true, force: true });
      }
    }

    for (const entry of entries) {
      if (!fs.existsSync(entry.directory)) continue;
      const server = new MinecraftServer(entry);
      this._wireEvents(server);
      this.servers.set(server.id, server);
    }
  }

  listServers() {
    return Array.from(this.servers.values()).map(s => s.getInfo());
  }

  getServer(id) {
    const server = this.servers.get(id);
    if (!server) throw new Error(`Server not found: ${id}`);
    return server;
  }

  createServer({ name, templateName, port, motd, maxPlayers, gamemode, difficulty, hardcore, minRam, maxRam, pvp, viewDistance, simulationDistance, whitelist }) {
    if (!name || !templateName) {
      throw new Error('name and templateName are required');
    }

    if (!/^[a-zA-Z0-9 _.-]+$/.test(name)) throw new Error('Invalid server name');

    const templateDir = path.join(config.TEMPLATES_DIR, templateName);
    if (!fs.existsSync(templateDir)) {
      throw new Error(`Template not found: ${templateName}`);
    }

    // Read template.json for start configuration
    const templateJsonPath = path.join(templateDir, 'template.json');
    let startArgs = ['-jar', 'server.jar', 'nogui'];
    if (fs.existsSync(templateJsonPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(templateJsonPath, 'utf-8'));
        if (meta.startArgs) {
          startArgs = meta.startArgs;
        } else if (meta.serverJar) {
          startArgs = ['-jar', meta.serverJar, 'nogui'];
        }
      } catch {}
    }

    // Validate jar exists for jar-mode templates
    if (startArgs[0] === '-jar') {
      if (!fs.existsSync(path.join(templateDir, startArgs[1]))) {
        throw new Error(`Template "${templateName}" is missing ${startArgs[1]}`);
      }
    }

    if (!port) {
      port = config.BASE_MC_PORT;
    } else {
      port = parseInt(port, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        throw new Error('Port must be between 1024 and 65535');
      }
    }

    const id = uuidv4();
    const serverDir = path.join(config.SERVERS_DIR, id);

    // Copy common defaults first, then overlay template
    const commonDir = path.join(config.TEMPLATES_DIR, 'common');
    if (fs.existsSync(commonDir)) {
      fs.cpSync(commonDir, serverDir, { recursive: true });
    }
    fs.cpSync(templateDir, serverDir, { recursive: true });

    // Build server.properties updates
    const propsPath = path.join(serverDir, 'server.properties');
    const updates = { 'server-port': String(port) };
    if (motd) updates.motd = motd;
    if (maxPlayers) updates['max-players'] = String(maxPlayers);
    if (gamemode) updates.gamemode = gamemode;
    if (difficulty) updates.difficulty = difficulty;
    if (hardcore !== undefined) updates.hardcore = String(hardcore);
    if (pvp !== undefined) updates.pvp = String(pvp);
    if (viewDistance) updates['view-distance'] = String(viewDistance);
    if (simulationDistance) updates['simulation-distance'] = String(simulationDistance);
    if (whitelist !== undefined) {
      updates['white-list'] = String(whitelist);
      updates['enforce-whitelist'] = String(whitelist);
    }

    if (fs.existsSync(propsPath)) {
      const { lines } = properties.parse(propsPath);
      properties.write(propsPath, updates, lines);
    } else {
      if (!updates.motd) updates.motd = 'A Minecraft Server';
      if (!updates['max-players']) updates['max-players'] = '21';
      if (!updates.gamemode) updates.gamemode = 'survival';
      if (!updates.difficulty) updates.difficulty = 'normal';
      properties.write(propsPath, updates, []);
    }

    // Ensure EULA is accepted
    const eulaPath = path.join(serverDir, 'eula.txt');
    if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf-8').includes('eula=true')) {
      fs.writeFileSync(eulaPath, 'eula=true\n', 'utf-8');
    }

    const resolvedMinRam = minRam || config.DEFAULT_MIN_RAM;
    const resolvedMaxRam = maxRam || config.DEFAULT_MAX_RAM;
    if (!/^\d+[MG]$/.test(resolvedMinRam) || !/^\d+[MG]$/.test(resolvedMaxRam)) {
      throw new Error('Invalid RAM format');
    }

    const server = new MinecraftServer({
      id,
      name,
      templateName,
      directory: serverDir,
      port,
      startArgs,
      minRam: resolvedMinRam,
      maxRam: resolvedMaxRam,
      createdAt: new Date().toISOString(),
    });

    this._wireEvents(server);
    this.servers.set(id, server);
    this._persist();

    return server.getInfo();
  }

  // --- Edit server settings ---

  getServerSettings(id) {
    const server = this.getServer(id);
    const propsPath = path.join(server.directory, 'server.properties');
    let entries = {};
    if (fs.existsSync(propsPath)) {
      entries = properties.parse(propsPath).entries;
    }
    return {
      name: server.name,
      motd: entries.motd || '',
      difficulty: entries.difficulty || 'normal',
      gamemode: entries.gamemode || 'survival',
      hardcore: entries.hardcore === 'true',
      maxRam: server.maxRam,
      pvp: entries.pvp !== 'false',
      port: server.port,
      viewDistance: parseInt(entries['view-distance']) || 10,
      simulationDistance: parseInt(entries['simulation-distance']) || 10,
      whitelist: entries['white-list'] === 'true',
      maxPlayers: parseInt(entries['max-players']) || 21,
    };
  }

  updateServer(id, { name, motd, difficulty, gamemode, hardcore, maxRam, pvp, port, viewDistance, simulationDistance, whitelist, maxPlayers }) {
    const server = this.getServer(id);

    // Update in-memory fields
    if (name && name !== server.name) {
      if (!/^[a-zA-Z0-9 _.-]+$/.test(name)) throw new Error('Invalid server name');
      server.name = name;
    }
    if (maxRam) {
      if (!/^\d+[MG]$/.test(maxRam)) throw new Error('Invalid RAM format');
      server.maxRam = maxRam;
    }
    if (port !== undefined) {
      port = parseInt(port, 10);
      if (isNaN(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
      server.port = port;
    }

    // Write server.properties
    const propsPath = path.join(server.directory, 'server.properties');
    let lines = [];
    if (fs.existsSync(propsPath)) {
      lines = properties.parse(propsPath).lines;
    }
    const propsUpdates = {};
    if (motd !== undefined) propsUpdates.motd = motd;
    if (difficulty) propsUpdates.difficulty = difficulty;
    if (gamemode) propsUpdates.gamemode = gamemode;
    if (hardcore !== undefined) propsUpdates.hardcore = String(hardcore);
    if (pvp !== undefined) propsUpdates.pvp = String(pvp);
    if (port !== undefined) propsUpdates['server-port'] = String(port);
    if (viewDistance !== undefined) propsUpdates['view-distance'] = String(viewDistance);
    if (simulationDistance !== undefined) propsUpdates['simulation-distance'] = String(simulationDistance);
    if (whitelist !== undefined) {
      propsUpdates['white-list'] = String(whitelist);
      propsUpdates['enforce-whitelist'] = String(whitelist);
    }
    if (maxPlayers !== undefined) propsUpdates['max-players'] = String(maxPlayers);

    properties.write(propsPath, propsUpdates, lines);
    this._persist();

    return server.getInfo();
  }

  // --- Server icon ---

  async setServerIcon(id, imageBuffer) {
    const server = this.getServer(id);
    const iconPath = path.join(server.directory, 'server-icon.png');
    await sharp(Buffer.from(imageBuffer))
      .resize(64, 64, { fit: 'cover' })
      .png()
      .toFile(iconPath);
  }

  // --- Template upload ---

  async uploadTemplate(name, zipFilePath) {
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error('Invalid template name (alphanumeric, dots, dashes, underscores only)');
    }
    if (name === 'common') {
      throw new Error('Cannot use reserved name "common"');
    }
    const templateDir = path.join(config.TEMPLATES_DIR, name);
    if (fs.existsSync(templateDir)) {
      throw new Error(`Template "${name}" already exists`);
    }

    const tempDir = path.join(config.TEMPLATES_DIR, `_uploading_${name}`);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const zip = new AdmZip(zipFilePath);
    await zip.extractAllToAsync(tempDir, true);

    // Build file list
    const files = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else files.push(rel);
      }
    };
    walk(tempDir, '');

    return files;
  }

  finalizeTemplate(name, { serverJar, customArgs }) {
    const tempDir = path.join(config.TEMPLATES_DIR, `_uploading_${name}`);
    if (!fs.existsSync(tempDir)) {
      throw new Error('No pending upload for this template');
    }

    let meta;
    if (customArgs) {
      // Custom args mode (e.g. NeoForge: "@user_jvm_args.txt @libraries/.../win_args.txt")
      const args = customArgs.trim().split(/\s+/);
      if (args.length === 0) throw new Error('Custom arguments cannot be empty');
      meta = { startArgs: args };
    } else if (serverJar) {
      // Standard jar mode
      if (serverJar.includes('..') || path.isAbsolute(serverJar)) {
        throw new Error('Invalid server jar path');
      }
      const jarPath = path.join(tempDir, serverJar);
      if (!fs.existsSync(jarPath)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw new Error(`Selected file not found: ${serverJar}`);
      }
      meta = { startArgs: ['-jar', serverJar, 'nogui'] };
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error('Must provide either a server jar or custom arguments');
    }

    const templateDir = path.join(config.TEMPLATES_DIR, name);
    try {
      fs.renameSync(tempDir, templateDir);
    } catch {
      fs.cpSync(tempDir, templateDir, { recursive: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    fs.writeFileSync(
      path.join(templateDir, 'template.json'),
      JSON.stringify(meta, null, 2),
      'utf-8'
    );

    return { name, startArgs: meta.startArgs };
  }

  cancelTemplateUpload(name) {
    const tempDir = path.join(config.TEMPLATES_DIR, `_uploading_${name}`);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // --- Existing methods ---

  async deleteServer(id) {
    const server = this.getServer(id);

    if (server.status === STATUS.RUNNING || server.status === STATUS.STARTING) {
      await server.stop();
    }

    this.servers.delete(id);
    fs.rmSync(server.directory, { recursive: true, force: true });
    this._persist();
  }

  startServer(id) {
    const server = this.getServer(id);

    // Resolve port conflicts against running servers
    if (this._isPortInUseByRunning(server.port, server.id)) {
      const oldPort = server.port;
      const newPort = this._nextAvailablePort(server.id);
      server.port = newPort;

      // Update server.properties with the new port
      const propsPath = path.join(server.directory, 'server.properties');
      if (fs.existsSync(propsPath)) {
        const { lines } = properties.parse(propsPath);
        properties.write(propsPath, { 'server-port': String(newPort) }, lines);
      }

      this._persist();
      server._pushOutput(`[SYSTEM] Port ${oldPort} is in use by another running server, reassigned to ${newPort}`, 'stderr');
      this.emit('server:status', server.id, server.getInfo());
    }

    server.start();
  }

  async stopServer(id) {
    await this.getServer(id).stop();
  }

  sendCommand(id, command) {
    this.getServer(id).sendCommand(command);
  }

  getAvailableTemplates() {
    return fs.readdirSync(config.TEMPLATES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'common' && !d.name.startsWith('_uploading_'))
      .map(d => {
        const templateJsonPath = path.join(config.TEMPLATES_DIR, d.name, 'template.json');
        let ready = fs.existsSync(path.join(config.TEMPLATES_DIR, d.name, 'server.jar'));
        if (fs.existsSync(templateJsonPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(templateJsonPath, 'utf-8'));
            if (meta.startArgs) {
              // Custom args mode — template is ready if template.json exists
              ready = true;
            } else if (meta.serverJar) {
              ready = fs.existsSync(path.join(config.TEMPLATES_DIR, d.name, meta.serverJar));
            }
          } catch {}
        }
        return { name: d.name, hasJar: ready };
      });
  }

  _wireEvents(server) {
    server.on('output', (data) => this.emit('server:output', server.id, data));
    server.on('status', (info) => this.emit('server:status', server.id, info));
    server.on('started', () => this.emit('server:started', server.id));
    server.on('stopped', () => this.emit('server:stopped', server.id));
    server.on('crashed', (data) => this.emit('server:crashed', server.id, data));
    server.on('error', (err) => this.emit('server:error', server.id, err));
  }

  _nextAvailablePort(excludeId) {
    let port = config.BASE_MC_PORT;
    while (this._isPortInUseByRunning(port, excludeId)) {
      port++;
      if (port > 65535) throw new Error('No available ports');
    }
    return port;
  }

  _isPortInUseByRunning(port, excludeId) {
    for (const server of this.servers.values()) {
      if (server.id === excludeId) continue;
      if (server.port === port && (server.status === STATUS.RUNNING || server.status === STATUS.STARTING)) {
        return true;
      }
    }
    return false;
  }

  _persist() {
    const data = Array.from(this.servers.values()).map(s => s.toJSON());
    fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf-8');
  }
}

module.exports = ServerManager;
