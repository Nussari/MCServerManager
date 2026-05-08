const config = require('./utils/config');
const { STATUS } = require('./services/MinecraftServer');
const { createApp } = require('./app');

const { server, manager } = createApp();

manager.init();
console.log(`Loaded ${manager.listServers().length} server(s) from registry`);

server.listen(config.PORT, () => {
  console.log(`Minecraft Server Manager running on http://localhost:${config.PORT}`);
});

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
