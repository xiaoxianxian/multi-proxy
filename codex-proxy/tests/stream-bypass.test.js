/**
 * Stream Bypass Test — codex-proxy /v1/chat/completions stream path
 *
 * Documents the B6 bug: response.body.pipeTo(res) fails because
 * Express ServerResponse is NOT a WHATWG WritableStream.
 * This test deliberately asserts the failure to lock in the regression.
 */

const express = require('express');
const { Readable } = require('stream');

// ===== Inline UPSTREAM_MODELS (same as proxy.js) =====
const UPSTREAM_MODELS = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'mock-deepseek-key',
    availableModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: 'mock-kimi-key',
    availableModels: ['moonshot-v1-8k', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'moonshot-v1-128k', 'moonshot-v1-128k-vision-preview', 'moonshot-v1-32k', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-8k-vision-preview', 'moonshot-v1-auto'],
  },
  {
    name: 'Agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: 'mock-agnes-key',
    availableModels: ['agnes-2.0-flash', 'agnes-1.5-flash', 'agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-video-v2.0'],
  },
];

function findProvider(modelName) {
  if (!modelName) return null;
  let provider = UPSTREAM_MODELS.find(p => p.availableModels.includes(modelName));
  if (provider) return provider;
  const lower = modelName.toLowerCase();
  if (lower.includes('deepseek')) return UPSTREAM_MODELS[0];
  if (lower.includes('kimi') || lower.includes('moonshot')) return UPSTREAM_MODELS[1];
  if (lower.includes('agnes')) return UPSTREAM_MODELS[2];
  return null;
}

// ===== Build test app mirroring proxy.js:588-635 EXACTLY =====
function buildTestApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const requireAuth = (req, res, next) => next();

  app.post('/v1/chat/completions', requireAuth, async (req, res) => {
    try {
      const { model } = req.body;
      const provider = findProvider(model);
      if (!provider) {
        return res.status(400).json({ success: false, error: `Unsupported model: ${model}`, code: 'UNSUPPORTED_MODEL' });
      }
      const upstreamUrl = `${provider.baseUrl}/chat/completions`;
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        const err = await response.text();
        console.error(`Chat upstream error (status ${response.status}): ${err}`);
        return res.status(response.status).json({ success: false, error: 'Upstream error', code: 'UPSTREAM_ERROR' });
      }
      if (req.body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        try {
          // B6 fix (mirrors proxy.js): Web ReadableStream → Node .pipe(res)
          const readable = Readable.fromWeb(response.body);
          readable.on('error', (err) => {
            console.error(`[Stream] Upstream read error: ${err.message}`);
            if (!res.headersSent) {
              res.status(504).json({ success: false, error: 'Stream timeout or upstream disconnected', code: 'STREAM_TIMEOUT' });
            } else {
              res.end();
            }
          });
          await new Promise((resolve, reject) => {
            readable.pipe(res);
            res.on('close', resolve);
            res.on('finish', resolve);
            res.on('error', reject);
          });
        } catch (err) {
          console.error(`[Stream] Pipe error: ${err.message}`);
          if (!res.headersSent) {
            res.status(504).json({ success: false, error: 'Stream timeout or upstream disconnected', code: 'STREAM_TIMEOUT' });
          }
        }
       } else {
        const data = await response.json();
        res.json(data);
      }
    } catch (e) {
      console.error(`Chat error: ${e.message}`);
      res.status(500).json({ success: false, error: e.message, code: 'CHAT_ERROR' });
    }
  });
  return app;
}

describe('Codex Proxy — /v1/chat/completions stream bypass test', () => {
  let app;
  let fetchSpy;

  beforeEach(() => {
    app = buildTestApp();
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ─── Non-stream path (baseline) ───
  it('non-stream request: returns JSON response from upstream', async () => {
    const mockBody = { id: 'mock-1', object: 'chat.completion', choices: [{ message: { content: 'Hello!' } }] };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(mockBody),
      text: jest.fn().mockResolvedValue(''),
      body: null,
    });

    const res = await require('supertest')(app)
      .post('/v1/chat/completions')
      .set('Content-Type', 'application/json')
      .send({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], stream: false });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('mock-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('deepseek.com');
  });

  // ─── Stream path: B6 fix verified (was: B6 bug assertion) ───
  it('B6 FIXED: stream request returns 200 and forwards full SSE (Hel+lo+finish stop)', async () => {
    // Build a WHATWG ReadableStream with SSE chunks (same shape as a real
    // upstream streaming response body from global fetch).
   const chunks = [
      `id: 1\ndata: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ delta: { content: 'Hel' }, index: 0 }] })}\n\n`,
      `id: 2\ndata: ${JSON.stringify({ id: '2', object: 'chat.completion.chunk', choices: [{ delta: { content: 'lo' }, index: 1 }] })}\n\n`,
      `id: 3\ndata: ${JSON.stringify({ id: '3', object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop', index: 2 }] })}\n\n`,
    ];
   const encoder = new TextEncoder();
   const stream = new ReadableStream({
     start(controller) {
       for (const chunk of chunks) {
         controller.enqueue(encoder.encode(chunk));
        }
       controller.close();
      },
    });

   fetchSpy.mockResolvedValueOnce({
     ok: true,
     status: 200,
     body: stream,
     headers: new Headers({ 'content-type': 'text/event-stream' }),
    });

   const res = await require('supertest')(app)
      .post('/v1/chat/completions')
      .set('Accept', 'text/event-stream')
      .send({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], stream: true });

    // FIXED: Readable.fromWeb(response.body).pipe(res) bridges the Web
    // ReadableStream to the Node/Express res, so the full SSE stream forwards.
   expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');

    // supertest exposes the streamed body as res.text (and may also parse it
    // into res.body — fall back to raw text to capture the full SSE payload).
   const rawBody = typeof res.text === 'string' ? res.text : JSON.stringify(res.body || '');
   expect(rawBody).toContain('Hel');
   expect(rawBody).toContain('lo');
   expect(rawBody).toContain('finish_reason');
   expect(rawBody).toContain('stop');
   expect(rawBody).not.toContain('STREAM_TIMEOUT');
   expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ─── Upstream error path ───
  it('stream request: upstream 500 returns UPSTREAM_ERROR', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue('Internal Server Error from upstream'),
      body: null,
    });

    const res = await require('supertest')(app)
      .post('/v1/chat/completions')
      .send({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], stream: true });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
  });

  // ─── Unsupported model ───
  it('stream request: rejects unsupported model with 400', async () => {
    const res = await require('supertest')(app)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4-xyz', messages: [{ role: 'user', content: 'hi' }], stream: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_MODEL');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
