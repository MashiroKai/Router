/**
 * Protocol Translator — OpenAI Chat Completions <-> Anthropic Messages.
 *
 * Handles both request body conversion and SSE stream translation.
 */

// ── OpenAI -> Anthropic (Request Body) ──────────────────────────────

export function convertOpenAIToAnthropic(bodyStr, provider) {
  try {
    const req = JSON.parse(bodyStr);
    const out = {
      model: req.model || provider.models?.default || 'unknown',
    };
    if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
    else if (req.max_completion_tokens !== undefined) out.max_tokens = req.max_completion_tokens;
    else out.max_tokens = 8192;
    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (req.top_p !== undefined) out.top_p = req.top_p;
    if (req.stop !== undefined) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    if (req.stream !== undefined) out.stream = req.stream;
    if (req.metadata !== undefined) out.metadata = req.metadata;

    if (req.tools?.length) {
      out.tools = req.tools.map(t => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description,
        input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
      }));
    }

    if (req.tool_choice !== undefined) {
      if (req.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
      else if (req.tool_choice === 'none') out.tool_choice = { type: 'none' };
      else if (req.tool_choice?.type === 'function') {
        out.tool_choice = { type: 'tool', name: req.tool_choice.function?.name || req.tool_choice.name };
      }
    }

    const systemParts = [];
    const messages = [];

    for (const msg of (req.messages || [])) {
      if (msg.role === 'system' || msg.role === 'developer') {
        systemParts.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
        continue;
      }
      if (msg.role === 'tool') {
        const toolResult = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        };
        let userIdx = messages.length - 1;
        while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--;
        if (userIdx >= 0) {
          const lastUser = messages[userIdx];
          if (Array.isArray(lastUser.content)) lastUser.content.push(toolResult);
          else lastUser.content = [{ type: 'text', text: lastUser.content || '' }, toolResult];
        } else {
          messages.push({ role: 'user', content: [toolResult] });
        }
        continue;
      }
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const content = [];
        if (msg.content) {
          content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: JSON.parse(tc.function?.arguments || '{}'),
          });
        }
        messages.push({ role: 'assistant', content });
        continue;
      }
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (messages.length && messages[messages.length - 1].role === msg.role) {
        const last = messages[messages.length - 1];
        if (typeof last.content === 'string') {
          last.content += '\n\n' + text;
        } else if (Array.isArray(last.content)) {
          const textPart = last.content.find(c => c.type === 'text');
          if (textPart) textPart.text += '\n\n' + text;
          else last.content.push({ type: 'text', text });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }

    if (systemParts.length) out.system = systemParts.join('\n\n');
    out.messages = messages;
    return JSON.stringify(out);
  } catch (e) {
    console.error('[CONVERT ERROR]', e);
    return bodyStr;
  }
}

// ── Anthropic -> OpenAI (Response Body) ─────────────────────────────

export function convertAnthropicToOpenAI(bodyStr, targetModel) {
  try {
    const msg = JSON.parse(bodyStr);
    const textParts = [];
    const toolCalls = [];
    for (const block of (msg.content || [])) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }
    const finishReasonMap = {
      end_turn: 'stop',
      max_tokens: 'length',
      stop_sequence: 'stop',
      tool_use: toolCalls.length ? 'tool_calls' : 'stop',
    };
    const choice = {
      index: 0,
      message: {
        role: 'assistant',
        content: textParts.join('') || '',
      },
      finish_reason: finishReasonMap[msg.stop_reason] || msg.stop_reason || 'stop',
    };
    if (toolCalls.length) choice.message.tool_calls = toolCalls;
    return JSON.stringify({
      id: msg.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: targetModel || msg.model,
      choices: [choice],
      usage: {
        prompt_tokens: msg.usage?.input_tokens || 0,
        completion_tokens: msg.usage?.output_tokens || 0,
        total_tokens: (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0),
      },
    });
  } catch (e) {
    console.error('[RESPONSE CONVERT ERROR]', e);
    return bodyStr;
  }
}

// ── Anthropic SSE -> OpenAI SSE (Stream Translator) ─────────────────

export function createAnthropicToOpenAISSETranslator(targetModel) {
  let messageId = '';
  let modelName = targetModel || '';
  let hasSentRole = false;

  function emit(eventType, data) {
    const created = Math.floor(Date.now() / 1000);
    const chunks = [];

    if (eventType === 'message_start') {
      messageId = data.message?.id || messageId;
      if (!targetModel) modelName = data.message?.model || modelName;
      if (!hasSentRole) {
        hasSentRole = true;
        chunks.push(JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created,
          model: modelName,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        }));
      }
    } else if (eventType === 'content_block_start') {
      if (data.content_block?.type === 'tool_use') {
        chunks.push(JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created,
          model: modelName,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: data.index,
                id: data.content_block.id,
                type: 'function',
                function: { name: data.content_block.name, arguments: '' },
              }],
            },
            finish_reason: null,
          }],
        }));
      }
    } else if (eventType === 'content_block_delta') {
      const delta = data.delta;
      if (delta?.type === 'text_delta') {
        chunks.push(JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created,
          model: modelName,
          choices: [{ index: 0, delta: { content: delta.text || '' }, finish_reason: null }],
        }));
      } else if (delta?.type === 'input_json_delta') {
        const partial = delta.partial_json || '';
        chunks.push(JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created,
          model: modelName,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: data.index, function: { arguments: partial } }],
            },
            finish_reason: null,
          }],
        }));
      }
    } else if (eventType === 'message_delta') {
      const stopReasonMap = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls' };
      const finishReason = stopReasonMap[data.delta?.stop_reason] || data.delta?.stop_reason || null;
      const chunk = {
        id: messageId,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      if (data.usage) {
        chunk.usage = {
          prompt_tokens: data.usage.input_tokens || 0,
          completion_tokens: data.usage.output_tokens || 0,
          total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        };
      }
      chunks.push(JSON.stringify(chunk));
    }
    return chunks.map(c => 'data: ' + c + '\n\n');
  }

  return { emit };
}

// ── Unified SSE Parser ──────────────────────────────────────────────
// NOTE: single parser serves both logging and translation — no duplicate parsing.

export class SSEParser {
  /**
   * @param {object} opts
   * @param {function} opts.onEvent   - Called for each parsed SSE event: (eventType, dataStr, parsedJson) => void
   * @param {function} [opts.onRaw]   - Called with raw lines for forwarding: (line) => void
   */
  constructor(opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.onRaw = opts.onRaw || null;
    this.buffer = '';
    this.eventType = '';
  }

  feed(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);

      // Pass raw line to forwarding callback (includes \n)
      if (this.onRaw) this.onRaw(line + '\n');

      const trimmed = line.trim();

      if (trimmed.startsWith('event:')) {
        this.eventType = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const parsed = JSON.parse(dataStr);
            this.onEvent(this.eventType, dataStr, parsed);
          } catch {
            // Non-JSON data — still notify
            this.onEvent(this.eventType, dataStr, null);
          }
        }
        this.eventType = '';
      } else if (trimmed === '') {
        this.eventType = '';
      }
    }
  }

  flush() {
    // Process any remaining data in buffer
    if (this.buffer.trim()) {
      const remaining = this.buffer.trim();
      if (remaining.startsWith('data:')) {
        const dataStr = remaining.slice(5).trim();
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const parsed = JSON.parse(dataStr);
            this.onEvent(this.eventType, dataStr, parsed);
          } catch {}
        }
      }
    }
    this.buffer = '';
    this.eventType = '';
  }
}
