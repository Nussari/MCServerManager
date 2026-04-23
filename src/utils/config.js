const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.resolve(__dirname, '../..');

// Parse JAVA_<version> env vars (e.g. JAVA_21=/opt/java/21/bin/java)
const JAVA_VERSIONS = {};
for (const [key, value] of Object.entries(process.env)) {
  const m = key.match(/^JAVA_(\d+)$/);
  if (m) JAVA_VERSIONS[parseInt(m[1])] = value;
}

const config = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  SERVERS_DIR: process.env.SERVERS_DIR || path.join(ROOT_DIR, 'servers'),
  TEMPLATES_DIR: process.env.TEMPLATES_DIR || path.join(ROOT_DIR, 'templates'),
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT_DIR, 'data'),
  BACKUPS_DIR: process.env.BACKUPS_DIR || path.join(ROOT_DIR, 'backups'),
  DEFAULT_JAVA: process.env.DEFAULT_JAVA || 'java',
  DEFAULT_MIN_RAM: process.env.DEFAULT_MIN_RAM || '1024M',
  DEFAULT_MAX_RAM: process.env.DEFAULT_MAX_RAM || '6G',
  CONSOLE_BUFFER_SIZE: parseInt(process.env.CONSOLE_BUFFER_SIZE, 10) || 500,
  STOP_TIMEOUT_MS: parseInt(process.env.STOP_TIMEOUT_MS, 10) || 30000,
  BASE_MC_PORT: parseInt(process.env.BASE_MC_PORT, 10) || 25565,
  DEFAULT_JVM_FLAGS: process.env.DEFAULT_JVM_FLAGS || '',
  JAVA_VERSIONS,
};

// Ensure runtime directories exist
fs.mkdirSync(config.SERVERS_DIR, { recursive: true });
fs.mkdirSync(config.TEMPLATES_DIR, { recursive: true });
fs.mkdirSync(config.DATA_DIR, { recursive: true });
fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });

module.exports = config;
