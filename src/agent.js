'use strict';

const MAX_HISTORY = 50;

class Agent {
  constructor(client, config, logger) {
    this._client = client;
    this._model = config?.agent?.model || 'qwen2.5:14b';
    this._log = logger;
    this._history = [];
    this._busy = false;
    this._abortController = null;
  }

  async stream(content, { onChunk, onDone, onError }) {
    if (this._busy) {
      onError({ code: 'busy', message: 'A stream is already in progress' });
      return;
    }

    this._busy = true;
    this._abortController = new AbortController();
    this._history.push({ role: 'user', content });

    try {
      const response = await this._client.chat({
        model: this._model,
        messages: this._history,
        stream: true,
      });

      let assistantText = '';
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const part of response) {
        if (this._abortController.signal.aborted) {
          break;
        }

        const chunk = part.message.content;
        if (chunk) {
          assistantText += chunk;
          onChunk(chunk);
        }

        if (part.prompt_eval_count !== undefined) {
          inputTokens = part.prompt_eval_count;
        }
        if (part.eval_count !== undefined) {
          outputTokens = part.eval_count;
        }
      }

      if (this._abortController.signal.aborted) {
        // On abort: pop the user message, skip onDone
        this._history.pop();
        this._log('info', 'Stream aborted');
        return;
      }

      this._history.push({ role: 'assistant', content: assistantText });

      if (this._history.length > MAX_HISTORY) {
        this._history = this._history.slice(-MAX_HISTORY);
      }

      onDone({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      });
    } catch (err) {
      if (this._abortController.signal.aborted) {
        this._history.pop();
        this._log('info', 'Stream aborted during error');
        return;
      }
      this._history.pop();
      this._log('error', 'Stream error', { error: err.message });
      onError({ code: 'stream_error', message: err.message });
    } finally {
      this._busy = false;
      this._abortController = null;
    }
  }

  abort() {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  reset() {
    this._history = [];
    this._log('info', 'Conversation history cleared');
  }
}

module.exports = { Agent };
