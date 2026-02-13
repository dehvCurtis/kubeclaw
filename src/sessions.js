'use strict';

const crypto = require('node:crypto');
const { Agent } = require('./agent');

const MAX_HISTORY = 200;

class Session {
  constructor(key, agent) {
    this.key = key;
    this.agent = agent;
    this.history = [];
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    this.currentRunId = null;
  }

  pushMessage(role, text) {
    const msg = {
      id: crypto.randomUUID(),
      role,
      content: [{ type: 'text', text }],
      ts: Date.now(),
    };
    this.history.push(msg);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    this.lastActiveAt = Date.now();
    return msg;
  }

  toJSON() {
    return {
      key: this.key,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      messageCount: this.history.length,
    };
  }
}

class SessionManager {
  constructor(ollama, config, logger) {
    this._sessions = new Map();
    this._ollama = ollama;
    this._config = config;
    this._log = logger;
  }

  _createAgent() {
    return new Agent(this._ollama, this._config, this._log);
  }

  getOrCreate(key) {
    let session = this._sessions.get(key);
    if (!session) {
      session = new Session(key, this._createAgent());
      this._sessions.set(key, session);
      this._log('info', 'Session created', { key });
    }
    return session;
  }

  get(key) {
    return this._sessions.get(key) || null;
  }

  list({ activeMinutes, limit } = {}) {
    let sessions = [...this._sessions.values()];
    if (activeMinutes) {
      const cutoff = Date.now() - activeMinutes * 60_000;
      sessions = sessions.filter((s) => s.lastActiveAt >= cutoff);
    }
    sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    if (limit) {
      sessions = sessions.slice(0, limit);
    }
    return sessions.map((s) => s.toJSON());
  }

  delete(key) {
    const existed = this._sessions.delete(key);
    if (existed) {
      this._log('info', 'Session deleted', { key });
    }
    return existed;
  }

  clear() {
    const count = this._sessions.size;
    this._sessions.clear();
    if (count > 0) {
      this._log('info', 'All sessions cleared', { count });
    }
  }
}

module.exports = { Session, SessionManager };
