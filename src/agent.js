'use strict';

class Agent {
  constructor(client, config, logger) {
    this._client = client;
    this._model = config?.agent?.model || 'qwen2.5:14b';
    this._log = logger;
    this._history = [];
    this._busy = false;
  }

  async stream(content, { onChunk, onDone, onError }) {
    if (this._busy) {
      onError({ code: 'busy', message: 'A stream is already in progress' });
      return;
    }

    this._busy = true;
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

      this._history.push({ role: 'assistant', content: assistantText });

      onDone({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      });
    } catch (err) {
      this._history.pop();
      this._log('error', 'Stream error', { error: err.message });
      onError({ code: 'stream_error', message: err.message });
    } finally {
      this._busy = false;
    }
  }

  reset() {
    this._history = [];
    this._log('info', 'Conversation history cleared');
  }
}

module.exports = { Agent };
