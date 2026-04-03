const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const config = require('./utils/config');
const ServerManager = require('./services/ServerManager');
const { STATUS } = require('./services/MinecraftServer');
const mojang = require('./utils/mojang');

const pkg = require('../package.json');

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { maxHttpBufferSize: 5 * 1024 * 1024 });
const manager = new ServerManager();

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Version endpoint
app.get('/api/version', (_req, res) => res.json({ version: pkg.version }));

// HTTP template upload — streams ZIP to disk to avoid Socket.IO size limits
app.post('/api/upload-template', async (req, res) => {
  const name = req.query.name;
  if (!name) {
    return res.json({ ok: false, error: 'Missing template name' });
  }

  const tempZip = path.join(config.DATA_DIR, `_upload_${Date.now()}_${name}.zip`);
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tempZip);
      req.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
    });

    const files = await manager.uploadTemplate(name, tempZip);
    res.json({ ok: true, files });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  } finally {
    try { fs.rmSync(tempZip, { force: true }); } catch {}
  }
});

// HTTP server import — streams ZIP to disk, same pattern as template upload
app.post('/api/import-server', async (req, res) => {
  const name = req.query.name;
  if (!name) {
    return res.json({ ok: false, error: 'Missing server name' });
  }

  const tempZip = path.join(config.DATA_DIR, `_upload_${Date.now()}_import.zip`);
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tempZip);
      req.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
    });

    const result = await manager.importServer(name, tempZip);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  } finally {
    try { fs.rmSync(tempZip, { force: true }); } catch {}
  }
});

// Initialize server manager
manager.init();
console.log(`Loaded ${manager.listServers().length} server(s) from registry`);

// Forward server events to Socket.IO
manager.on('server:output', (serverId, data) => {
  io.to(`server:${serverId}`).emit('output', data);
});

manager.on('server:status', (serverId, info) => {
  io.to(`server:${serverId}`).emit('status-change', info);
  io.to('dashboard').emit('server-updated', info);
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  // Dashboard
  socket.on('join-dashboard', () => {
    socket.join('dashboard');
  });

  socket.on('list-servers', (callback) => {
    if (callback) callback(manager.listServers());
  });

  socket.on('list-templates', (callback) => {
    if (callback) callback(manager.getAvailableTemplates());
  });

  socket.on('fetch-latest-release', async (callback) => {
    try {
      const { version, jarUrl, sha1 } = await mojang.getLatestRelease();
      const templateName = `Vanilla-${version}`;
      const templateDir = path.join(config.TEMPLATES_DIR, templateName);
      const cached = fs.existsSync(templateDir) && fs.existsSync(path.join(templateDir, 'server.jar'));
      callback({ ok: true, version, jarUrl, sha1, templateName, cached });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  // Server CRUD
  socket.on('create-server', async (data, callback) => {
    try {
      if (data._latestRelease) {
        const { jarUrl, sha1, templateName } = data._latestRelease;
        data.templateName = await manager.ensureVanillaTemplate(
          templateName.replace('Vanilla-', ''), jarUrl, sha1,
          (progress) => socket.emit('download-progress', progress)
        );
        delete data._latestRelease;
      }

      const info = manager.createServer(data);
      io.to('dashboard').emit('server-created', info);
      callback({ ok: true, server: info });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  socket.on('delete-server', async (data, callback) => {
    try {
      await manager.deleteServer(data.serverId);
      io.to('dashboard').emit('server-deleted', { serverId: data.serverId });
      callback({ ok: true });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  // Server control
  socket.on('start-server', (data, callback) => {
    try {
      manager.startServer(data.serverId);
      callback({ ok: true });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  socket.on('stop-server', async (data, callback) => {
    try {
      await manager.stopServer(data.serverId);
      callback({ ok: true });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  socket.on('send-command', (data, callback) => {
    try {
      manager.sendCommand(data.serverId, data.command);
      if (callback) callback({ ok: true });
    } catch (err) {
      if (callback) callback({ ok: false, error: err.message });
    }
  });

  // Server settings
  socket.on('get-server-settings', (data, callback) => {
    try {
      const settings = manager.getServerSettings(data.serverId);
      callback({ ok: true, settings });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  socket.on('update-server', (data, callback) => {
    try {
      const info = manager.updateServer(data.serverId, data);
      io.to(`server:${data.serverId}`).emit('status-change', info);
      io.to('dashboard').emit('server-updated', info);
      callback({ ok: true, server: info });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  // Server icon
  socket.on('upload-server-icon', async (data, callback) => {
    try {
      await manager.setServerIcon(data.serverId, data.imageData);
      callback({ ok: true });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  // Template finalize/cancel (upload is handled via HTTP POST /api/upload-template)
  socket.on('finalize-template', (data, callback) => {
    try {
      const result = manager.finalizeTemplate(data.name, {
        serverJar: data.serverJar,
        customArgs: data.customArgs,
      });
      callback({ ok: true, template: result });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  socket.on('cancel-template-upload', (data, callback) => {
    try {
      manager.cancelTemplateUpload(data.name);
      if (callback) callback({ ok: true });
    } catch (err) {
      if (callback) callback({ ok: false, error: err.message });
    }
  });

  socket.on('delete-template', (data, callback) => {
    try {
      manager.deleteTemplate(data.name);
      callback({ ok: true });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  // Import server finalize/cancel (upload is handled via HTTP POST /api/import-server)
  socket.on('finalize-import', (data, callback) => {
    try {
      const info = manager.finalizeImport(data.importId, data);
      io.to('dashboard').emit('server-created', info);
      callback({ ok: true, server: info });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  socket.on('cancel-import', (data, callback) => {
    try {
      manager.cancelImport(data.importId);
      if (callback) callback({ ok: true });
    } catch (err) {
      if (callback) callback({ ok: false, error: err.message });
    }
  });

  // Server console room
  socket.on('join-server', (data) => {
    if (!data || !data.serverId) return;
    try {
      const srv = manager.getServer(data.serverId);
      socket.join(`server:${data.serverId}`);
      socket.emit('output-history', srv.getOutputBuffer());
      socket.emit('status-change', srv.getInfo());
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('leave-server', (data) => {
    socket.leave(`server:${data.serverId}`);
  });
});

// Start listening
server.listen(config.PORT, () => {
  console.log(`Minecraft Server Manager running on http://localhost:${config.PORT}`);
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  const running = manager.listServers().filter(s => s.status === STATUS.RUNNING || s.status === STATUS.STARTING);

  if (running.length > 0) {
    console.log(`Stopping ${running.length} running server(s)...`);
    await Promise.all(running.map(s => manager.stopServer(s.id)));
    console.log('All servers stopped.');
  }

  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
