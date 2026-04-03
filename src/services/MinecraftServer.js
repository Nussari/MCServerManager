const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const config = require('../utils/config');
const { detectJavaVersion } = require('../utils/javaDetect');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  CRASHED: 'crashed',
};

const DONE_PATTERN = /Done \(\d+\.\d+s\)!/;
const PLAYER_JOIN_PATTERN = /: (.+) joined the game/;
const PLAYER_LEAVE_PATTERN = /: (.+) left the game/;

class MinecraftServer extends EventEmitter {
  constructor({ id, name, templateName, directory, port, javaPath, minRam, maxRam, startArgs, serverJar, createdAt }) {
    super();
    this.id = id;
    this.name = name;
    this.templateName = templateName;
    this.directory = directory;
    this.port = port;
    this.javaPath = javaPath || config.DEFAULT_JAVA;
    this.minRam = minRam || config.DEFAULT_MIN_RAM;
    this.maxRam = maxRam || config.DEFAULT_MAX_RAM;
    // startArgs is the canonical field; serverJar is for backward compat with old servers.json
    if (startArgs) {
      this.startArgs = startArgs;
    } else {
      this.startArgs = ['-jar', serverJar || 'server.jar', 'nogui'];
    }
    this.createdAt = createdAt;

    this.process = null;
    this.status = STATUS.STOPPED;
    this.startedAt = null;
    this.players = new Set();

    // Ring buffer for console output
    this._ringBuffer = new Array(config.CONSOLE_BUFFER_SIZE);
    this._ringWriteIndex = 0;
    this._ringCount = 0;

    this._stopPromise = null;
  }

  get playerCount() {
    return this.players.size;
  }

  start() {
    if (this.status !== STATUS.STOPPED && this.status !== STATUS.CRASHED) {
      throw new Error(`Server is ${this.status}, cannot start`);
    }

    const isJarMode = this.startArgs[0] === '-jar';
    if (isJarMode) {
      const jarPath = path.join(this.directory, this.startArgs[1]);
      if (!fs.existsSync(jarPath)) {
        throw new Error(`${this.startArgs[1]} not found in ${this.directory}`);
      }
    }

    const eulaPath = path.join(this.directory, 'eula.txt');
    if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf-8').includes('eula=true')) {
      throw new Error('eula.txt missing or not accepted');
    }

    this.status = STATUS.STARTING;
    this.players.clear();
    this.emit('status', this.getInfo());

    // Auto-detect Java version from server JAR
    let javaCmd = this.javaPath;
    let resolvedVersion = null;
    const installed = Object.keys(config.JAVA_VERSIONS).map(Number).sort((a, b) => a - b);
    if (installed.length > 0) {
      let detectJar = null;
      if (isJarMode) {
        detectJar = path.join(this.directory, this.startArgs[1]);
      } else {
        // Custom args mode (modded servers): try server.jar or first root-level JAR
        const serverJar = path.join(this.directory, 'server.jar');
        if (fs.existsSync(serverJar)) {
          detectJar = serverJar;
        } else {
          const rootJar = fs.readdirSync(this.directory).find(f => f.endsWith('.jar'));
          if (rootJar) detectJar = path.join(this.directory, rootJar);
        }
      }

      if (detectJar && fs.existsSync(detectJar)) {
        const required = detectJavaVersion(detectJar);
        if (required) {
          const match = installed.find(v => v >= required);
          if (match) {
            javaCmd = config.JAVA_VERSIONS[match];
            resolvedVersion = match;
            this._pushOutput(`[SYSTEM] Detected Java ${required} required, using Java ${match}`, 'stderr');
          }
        }
      }
    }

    // GC selection depends on Java version:
    // - JDK 21: Use ZGC to avoid G1 GC crash (JDK-8320253, not backported to 21)
    // - JDK 25+: Use Parallel GC — both G1 (JDK-8366580) and ZGC (ZMark::mark_and_follow)
    //   crash on JDK 25. Parallel GC has no concurrent barriers, avoiding both bugs.
    let gcFlags;
    if (resolvedVersion && resolvedVersion >= 25) {
      gcFlags = ['-XX:+UseParallelGC'];
    } else {
      gcFlags = ['-XX:+UseZGC'];
    }
    // Disable core dumps — a single crash writes a multi-GB file to the server directory
    const coreFlags = ['-XX:-CreateCoredumpOnCrash'];
    const extraFlags = config.DEFAULT_JVM_FLAGS ? config.DEFAULT_JVM_FLAGS.split(/\s+/).filter(Boolean) : [];

    // In jar mode, prepend RAM, GC, and extra flags.
    // In custom args mode, RAM is managed by the args files but GC/core flags still need injection.
    const jvmFlags = [...gcFlags, ...coreFlags, ...extraFlags];
    const args = isJarMode
      ? [`-Xms${this.minRam}`, `-Xmx${this.maxRam}`, ...jvmFlags, ...this.startArgs]
      : [...jvmFlags, ...this.startArgs];

    this.process = spawn(javaCmd, args, {
      cwd: this.directory,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const attachStream = (stream, name) => {
      const rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => {
        this._pushOutput(line, name);

        if (name === 'stdout') {
          if (DONE_PATTERN.test(line)) {
            this.status = STATUS.RUNNING;
            this.startedAt = new Date().toISOString();
            this.emit('started');
            this.emit('status', this.getInfo());
          }

          const joinMatch = line.match(PLAYER_JOIN_PATTERN);
          if (joinMatch) {
            this.players.add(joinMatch[1]);
            this.emit('status', this.getInfo());
          }

          const leaveMatch = line.match(PLAYER_LEAVE_PATTERN);
          if (leaveMatch) {
            this.players.delete(leaveMatch[1]);
            this.emit('status', this.getInfo());
          }
        }
      });
    };

    attachStream(this.process.stdout, 'stdout');
    attachStream(this.process.stderr, 'stderr');

    this.process.on('close', (code, signal) => {
      const wasStopping = this.status === STATUS.STOPPING;
      this.process = null;
      this._stopPromise = null;

      if (wasStopping) {
        this.status = STATUS.STOPPED;
        this.emit('stopped');
      } else {
        this.status = STATUS.CRASHED;
        this.emit('crashed', { code, signal });
      }

      this.startedAt = null;
      this.players.clear();
      this.emit('status', this.getInfo());
    });

    this.process.on('error', (err) => {
      this.process = null;
      this._stopPromise = null;
      this.status = STATUS.CRASHED;
      this._pushOutput(`[ERROR] Failed to start: ${err.message}`, 'stderr');
      this.emit('error', err);
      this.emit('status', this.getInfo());
    });
  }

  stop() {
    if (!this.process) return Promise.resolve();
    if (this._stopPromise) return this._stopPromise;

    this.status = STATUS.STOPPING;
    this.emit('status', this.getInfo());
    this.process.stdin.write('stop\n');

    this._stopPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this._pushOutput('[SYSTEM] Force-killing server (timeout)', 'stderr');
          this.process.kill('SIGKILL');
        }
      }, config.STOP_TIMEOUT_MS);

      const onStopped = () => { this.removeListener('crashed', onCrashed); clearTimeout(timeout); resolve(); };
      const onCrashed = () => { this.removeListener('stopped', onStopped); clearTimeout(timeout); resolve(); };
      this.once('stopped', onStopped);
      this.once('crashed', onCrashed);
    });

    return this._stopPromise;
  }

  sendCommand(command) {
    if (this.status !== STATUS.RUNNING) {
      throw new Error(`Server is ${this.status}, cannot send commands`);
    }
    this._pushOutput(`> ${command}`, 'command');
    this.process.stdin.write(command + '\n');
  }

  getInfo() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      port: this.port,
      templateName: this.templateName,
      playerCount: this.playerCount,
      startedAt: this.startedAt,
      createdAt: this.createdAt,
      minRam: this.minRam,
      maxRam: this.maxRam,
    };
  }

  getOutputBuffer() {
    if (this._ringCount === 0) return [];
    const buf = [];
    const size = config.CONSOLE_BUFFER_SIZE;
    const start = this._ringCount < size
      ? 0
      : this._ringWriteIndex;
    for (let i = 0; i < this._ringCount; i++) {
      buf.push(this._ringBuffer[(start + i) % size]);
    }
    return buf;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      templateName: this.templateName,
      directory: this.directory,
      port: this.port,
      javaPath: this.javaPath,
      minRam: this.minRam,
      maxRam: this.maxRam,
      startArgs: this.startArgs,
      createdAt: this.createdAt,
    };
  }

  _pushOutput(line, stream) {
    const entry = { line, stream, timestamp: new Date().toISOString() };
    this._ringBuffer[this._ringWriteIndex] = entry;
    this._ringWriteIndex = (this._ringWriteIndex + 1) % config.CONSOLE_BUFFER_SIZE;
    if (this._ringCount < config.CONSOLE_BUFFER_SIZE) this._ringCount++;
    this.emit('output', entry);
  }
}

module.exports = { MinecraftServer, STATUS };
