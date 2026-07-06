const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`[REGISTRY] Failed reading ${filePath}:`, error);
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

class JsonRegistry {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
  }

  read() {
    return readJson(this.filePath, this.fallback);
  }

  write(data) {
    writeJson(this.filePath, data);
  }

  get(id) {
    const data = this.read();
    return data[id] || null;
  }

  set(id, value) {
    const data = this.read();
    data[id] = {
      ...(data[id] || {}),
      ...value,
      updatedAt: new Date().toISOString()
    };
    this.write(data);
    return data[id];
  }

  update(id, updater) {
    const data = this.read();
    const nextValue = updater(data[id] || null);
    if (nextValue === null || nextValue === undefined) {
      delete data[id];
      this.write(data);
      return null;
    }

    data[id] = {
      ...(data[id] || {}),
      ...nextValue,
      updatedAt: new Date().toISOString()
    };
    this.write(data);
    return data[id];
  }

  delete(id) {
    const data = this.read();
    delete data[id];
    this.write(data);
  }
}

function createRegistries(baseDir) {
  ensureDir(baseDir);
  return {
    files: new JsonRegistry(path.join(baseDir, '.tweetweb-files.json'), {}),
    shares: new JsonRegistry(path.join(baseDir, '.tweetweb-shares.json'), {}),
    sessions: new JsonRegistry(path.join(baseDir, '.tweetweb-download-sessions.json'), {})
  };
}

module.exports = {
  createRegistries
};
