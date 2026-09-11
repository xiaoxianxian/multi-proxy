'use strict';

// jest test for Sessions API routes
const request = require('supertest');
const express = require('express');

// Create mock store before requiring routes
const mockSessions = new Map();
let nextId = 1;

const mockStore = {
    list: (filter = {}) => {
        let result = [...mockSessions.values()];
        if (filter.proxy) result = result.filter(s => s.proxy === filter.proxy);
        if (filter.status) result = result.filter(s => s.status === filter.status);
        return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    getRunning: () => [...mockSessions.values()].filter(s => s.status === 'running'),
    get: (id) => {
        const s = mockSessions.get(id);
        if (!s) throw new Error(`session not found: ${id}`);
        return s;
    },
    create: (session) => {
        const id = session.sessionId || `sess-${nextId++}`;
        const full = { ...session, sessionId: id, steps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'running' };
        mockSessions.set(id, full);
        return full;
    },
    update: (id, patch) => {
        const cur = mockSessions.get(id);
        if (!cur) throw new Error(`session not found: ${id}`);
        const merged = { ...cur, ...patch, sessionId: id, updatedAt: new Date().toISOString() };
        mockSessions.set(id, merged);
        return merged;
    },
    addStep: (id, step) => {
        const cur = mockSessions.get(id);
        if (!cur) throw new Error(`session not found: ${id}`);
        const newSteps = [...cur.steps, { ...step, timestamp: new Date().toISOString() }];
        mockSessions.set(id, { ...cur, steps: newSteps, updatedAt: new Date().toISOString() });
        return { ...cur, steps: newSteps };
    },
    abort: (id, by = 'user') => mockStore.update(id, { status: 'aborted', abortedBy: by }),
    markDone: (id) => mockStore.update(id, { status: 'done' }),
    markFailed: (id, error) => mockStore.update(id, { status: 'failed', error: error?.message || String(error) }),
    remove: (id) => {
        if (!mockSessions.has(id)) throw new Error(`session not found: ${id}`);
        mockSessions.delete(id);
    },
    count: () => mockSessions.size,
    clear: () => { mockSessions.clear(); nextId = 1; }
};

// Mock the module
jest.mock('../../../multi-proxy-manager/lib/session-store', () => ({
    SessionStore: class { constructor() {} },
    __mockStore: mockStore
}));

const sessionsRoutes = require('../../../multi-proxy-manager/routes/sessions');

const app = express();
app.use(express.json());
app.use('/api/sessions', sessionsRoutes);

// Inject mock store
sessionsRoutes.setStore(mockStore);

describe('Sessions API', () => {
    beforeEach(() => {
        mockStore.clear();
    });

    test('GET /api/sessions returns empty list', async () => {
        const res = await request(app).get('/api/sessions');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.sessions).toEqual([]);
    });

    test('POST /api/sessions creates session', async () => {
        const res = await request(app)
            .post('/api/sessions')
            .send({ proxy: 'codex', task: { type: 'coding', prompt: 'fix bug' } });
        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);
        expect(res.body.session.proxy).toBe('codex');
        expect(res.body.session.sessionId).toBeTruthy();
    });

    test('POST /api/sessions rejects missing proxy/task', async () => {
        const res = await request(app)
            .post('/api/sessions')
            .send({ task: { type: 'coding' } });
        expect(res.status).toBe(400);
    });

    test('GET /api/sessions/running', async () => {
        // Create a running session
        await request(app)
            .post('/api/sessions')
            .send({ proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        
        const res = await request(app).get('/api/sessions/running');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.sessions.length).toBeGreaterThan(0);
    });

    test('POST /api/sessions/:id/abort', async () => {
        const createRes = await request(app)
            .post('/api/sessions')
            .send({ proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        const sessionId = createRes.body.session.sessionId;

        const res = await request(app)
            .post(`/api/sessions/${sessionId}/abort`)
            .send({ by: 'user' });
        expect(res.status).toBe(200);
        expect(res.body.session.status).toBe('aborted');
        expect(res.body.session.abortedBy).toBe('user');
    });

    test('POST /api/sessions/:id/done', async () => {
        const createRes = await request(app)
            .post('/api/sessions')
            .send({ proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        const sessionId = createRes.body.session.sessionId;

        const res = await request(app)
            .post(`/api/sessions/${sessionId}/done`);
        expect(res.status).toBe(200);
        expect(res.body.session.status).toBe('done');
    });

    test('GET /api/sessions/:id returns 404 for missing', async () => {
        const res = await request(app).get('/api/sessions/nonexistent');
        expect(res.status).toBe(404);
    });
});
