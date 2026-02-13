'use strict';

const crypto = require('node:crypto');

const VERSION = '0.6.0';

class RpcHandler {
  constructor(sessionManager, config, logger, sendFn) {
    this._sessions = sessionManager;
    this._config = config;
    this._log = logger;
    this._send = sendFn;
    this._connected = false;
    this._seq = 0;

    this._agentName = config?.agent?.name || 'OpenClaw';
    this._agentDescription = config?.agent?.description || 'AI assistant powered by Ollama';
    this._model = config?.agent?.model || 'qwen2.5:14b';

    this._methods = new Map();
    this._registerMethods();
  }

  _registerMethods() {
    // Connection
    this._methods.set('connect', (params) => this._connect(params));

    // Chat
    this._methods.set('chat.send', (params) => this._chatSend(params));
    this._methods.set('chat.history', (params) => this._chatHistory(params));
    this._methods.set('chat.abort', (params) => this._chatAbort(params));

    // Agents
    this._methods.set('agents.list', () => this._agentsList());
    this._methods.set('agent.identity.get', () => this._agentIdentityGet());

    // Sessions
    this._methods.set('sessions.list', (params) => this._sessionsList(params));
    this._methods.set('sessions.patch', (params) => this._sessionsPatch(params));
    this._methods.set('sessions.delete', (params) => this._sessionsDelete(params));

    // Nodes
    this._methods.set('node.list', () => this._nodeList());

    // Stubs
    this._methods.set('health', () => ({ status: 'ok' }));
    this._methods.set('status', () => ({ status: 'ok', version: VERSION }));
    this._methods.set('config.get', () => ({
      config: {
        agent: {
          model: this._model,
          name: this._agentName,
          description: this._agentDescription,
        },
      },
    }));
    this._methods.set('config.schema', () => ({ schema: {} }));
    this._methods.set('models.list', () => ({
      models: [{ id: this._model, name: this._model }],
    }));
  }

  async dispatch(msg) {
    if (msg.type !== 'req') {
      this._sendError(null, `Unsupported message type: ${msg.type}`);
      return;
    }

    const { id, method, params } = msg;

    if (!method) {
      this._sendError(id, 'Missing method');
      return;
    }

    // Require connect before other methods
    if (!this._connected && method !== 'connect') {
      this._sendError(id, 'Not connected — send "connect" first');
      return;
    }

    const handler = this._methods.get(method);
    if (!handler) {
      this._sendResponse(id, false, undefined, { message: `Method not implemented: ${method}` });
      return;
    }

    try {
      const result = await handler(params || {});
      this._sendResponse(id, true, result);
    } catch (err) {
      this._log('error', 'RPC handler error', { method, error: err.message });
      this._sendResponse(id, false, undefined, { message: err.message });
    }
  }

  _sendResponse(id, ok, payload, error) {
    const msg = { type: 'res', id, ok };
    if (ok) {
      msg.payload = payload || {};
    } else {
      msg.error = error || { message: 'Unknown error' };
    }
    this._send(msg);
  }

  _sendError(id, message) {
    this._sendResponse(id, false, undefined, { message });
  }

  _emitEvent(event, payload) {
    this._send({
      type: 'event',
      event,
      seq: ++this._seq,
      payload,
    });
  }

  // --- Method handlers ---

  _connect() {
    this._connected = true;
    // Ensure main session exists
    this._sessions.getOrCreate('main');
    this._log('info', 'RPC connect handshake completed');
    return {
      snapshot: {
        presence: [],
        sessionDefaults: {
          mainSessionKey: 'main',
        },
      },
    };
  }

  async _chatSend(params) {
    const { sessionKey = 'main', message } = params;

    if (!message || typeof message.content !== 'string') {
      throw new Error('Missing or invalid message content');
    }

    const text = typeof message.content === 'string'
      ? message.content
      : message.content?.[0]?.text || '';

    if (!text.trim()) {
      throw new Error('Empty message content');
    }

    const session = this._sessions.getOrCreate(sessionKey);
    const runId = crypto.randomUUID();
    session.currentRunId = runId;

    // Store user message in session history
    session.pushMessage('user', text);

    // Respond immediately with empty payload
    // (the response is sent by dispatch, we return here)
    // Then stream in the background
    this._streamChat(session, runId, text);

    return {};
  }

  async _streamChat(session, runId, text) {
    let accumulated = '';

    try {
      await session.agent.stream(text, {
        onChunk: (chunk) => {
          accumulated += chunk;
          // Check if run was cancelled
          if (session.currentRunId !== runId) return;

          this._emitEvent('chat', {
            sessionKey: session.key,
            runId,
            state: 'delta',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: accumulated }],
            },
          });
        },
        onDone: () => {
          if (session.currentRunId !== runId) return;

          // Store assistant message in session history
          session.pushMessage('assistant', accumulated);
          session.currentRunId = null;

          this._emitEvent('chat', {
            sessionKey: session.key,
            runId,
            state: 'final',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: accumulated }],
            },
          });
        },
        onError: (err) => {
          session.currentRunId = null;

          this._emitEvent('chat', {
            sessionKey: session.key,
            runId,
            state: 'error',
            errorMessage: err.message,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: accumulated }],
            },
          });
        },
      });
    } catch (err) {
      this._log('error', 'Stream chat error', { error: err.message });
      session.currentRunId = null;

      this._emitEvent('chat', {
        sessionKey: session.key,
        runId,
        state: 'error',
        errorMessage: err.message,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: accumulated }],
        },
      });
    }
  }

  _chatHistory(params) {
    const { sessionKey = 'main', limit } = params;
    const session = this._sessions.get(sessionKey);
    if (!session) {
      return { messages: [] };
    }
    let messages = session.history;
    if (limit && limit > 0) {
      messages = messages.slice(-limit);
    }
    return { messages };
  }

  _chatAbort(params) {
    const { sessionKey = 'main' } = params;
    const session = this._sessions.get(sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${sessionKey}`);
    }

    const runId = session.currentRunId;
    session.currentRunId = null;
    session.agent.abort();

    if (runId) {
      this._emitEvent('chat', {
        sessionKey: session.key,
        runId,
        state: 'aborted',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
        },
      });
    }

    return {};
  }

  _agentsList() {
    return {
      agents: [{
        id: 'main',
        name: this._agentName,
        description: this._agentDescription,
        model: this._model,
      }],
      defaultId: 'main',
    };
  }

  _agentIdentityGet() {
    return {
      name: this._agentName,
      agentId: 'main',
    };
  }

  _sessionsList(params) {
    const { activeMinutes, limit } = params || {};
    return {
      sessions: this._sessions.list({ activeMinutes, limit }),
    };
  }

  _sessionsPatch(params) {
    const { sessionKey } = params || {};
    if (sessionKey) {
      this._sessions.getOrCreate(sessionKey);
    }
    return {};
  }

  _sessionsDelete(params) {
    const { sessionKey } = params || {};
    if (sessionKey) {
      this._sessions.delete(sessionKey);
    }
    return {};
  }

  _nodeList() {
    return { nodes: [] };
  }
}

module.exports = { RpcHandler };
