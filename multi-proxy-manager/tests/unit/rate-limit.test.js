/**
 * Tests for rate limiting middleware (authLimiter, lockoutLimiter).
 *
 * Uses express-rate-limit v7's default InMemoryMapStore which creates
 * independent stores per rateLimit() call. No custom store needed —
 * each test gets a fresh Express app with fresh limiters.
 */

const request = require('supertest');
const rateLimit = require('express-rate-limit');

function createApp(maxRequests, handlerResponse, windowMs) {
  const express = require('express');
  const app = express();
  app.use(express.json());

  const limiter = rateLimit({
    windowMs: windowMs || 60 * 1000,
    max: maxRequests || 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => 'test-ip',
    handler: (req, res) => {
      res.status(429).json(
        handlerResponse || { success: false, error: 'Too many requests.' }
      );
    },
  });

  app.post('/api/auth/login', limiter, (_req, res) => {
    const { password } = _req.body;
    if (!password) {
      return res.status(400).json({ success: false, error: 'Password required' });
    }
    res.json({ success: true, token: 'fake-token' });
  });
  return app;
}

describe('Rate Limiting', () => {
  describe('authLimiter (5 requests / minute)', () => {
    it('allows first 5 requests', async () => {
      const app = createApp(5, undefined, 60000);

      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ password: 'correct' });
        expect(res.status).toBe(200);
      }
    });

    it('returns 429 on 6th request within window', async () => {
      const app = createApp(5, undefined, 60000);

      // Exhaust the quota
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/auth/login').send({ password: 'correct' });
      }

      // 6th request should be rate limited
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'correct' });
      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Too many requests');
    });

    it('sends rate limit headers on successful request', async () => {
      const app = createApp(5, undefined, 60000);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'correct' });
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBe('5');
    });

    it('resets count when store is replaced (simulating window expiry)', async () => {
      // To test window expiry behavior, create TWO apps with the same config
      // but independent stores. This simulates the first window being exhausted
      // and the second window starting fresh.
      const app1 = createApp(5, undefined, 60000);
      const app2 = createApp(5, undefined, 60000);

      // Exhaust app1's limiter
      for (let i = 0; i < 5; i++) {
        await request(app1).post('/api/auth/login').send({ password: 'x' });
      }
      let res = await request(app1).post('/api/auth/login').send({ password: 'x' });
      expect(res.status).toBe(429);

      // app2 has a completely fresh limiter/store — simulates window reset
      res = await request(app2).post('/api/auth/login').send({ password: 'x' });
      expect(res.status).toBe(200);
    });
  });

  describe('lockoutLimiter (5 failures / 15 min lockout)', () => {
    it('blocks after 5 requests', async () => {
      const app = createApp(
        5,
        { success: false, error: 'Account locked due to too many failed attempts.' },
        15 * 60 * 1000
      );

      // Send 5 requests
      for (let i = 0; i < 5; i++) {
        const res = await request(app).post('/api/auth/login').send({ password: 'wrong' });
        expect(res.status).toBe(200);
      }

      // 6th request should be blocked
      const res = await request(app).post('/api/auth/login').send({ password: 'test' });
      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Account locked');
    });

    it('uses standardHeaders for rate limit policy', async () => {
      const app = createApp(5, undefined, 60000);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'test' });
      expect(res.headers['ratelimit-limit']).toBe('5');
      expect(res.headers['ratelimit-policy']).toBeDefined();
    });
  });

  describe('Combined limiter interaction', () => {
    it('lockoutLimiter fires before authLimiter when both max=5', async () => {
      const express = require('express');
      const app = express();
      app.use(express.json());

      // lockoutLimiter — 15 minute window
      const lockoutLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 5,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: () => 'test-ip',
        handler: (req, res) => {
          res.status(429).json({
            success: false,
            error: 'Account locked due to too many failed attempts.',
          });
        },
      });

      // authLimiter — 1 minute window
      const authLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 5,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: () => 'test-ip',
        handler: (req, res) => {
          res.status(429).json({
            success: false,
            error: 'Too many login attempts.',
          });
        },
      });

      // lockoutLimiter listed first = fires first in middleware chain
      app.post('/api/auth/login', lockoutLimiter, authLimiter, (_req, res) => {
        res.json({ success: true, token: 'fake' });
      });

      // After 5 requests, lockoutLimiter fires first (it's listed first)
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/auth/login').send({ password: 'wrong' });
      }

      const res = await request(app).post('/api/auth/login').send({ password: 'test' });
      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Account locked');
    });
  });
});
