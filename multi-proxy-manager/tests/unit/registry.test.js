process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');

const AUTH_TOKEN = jwt.sign({ authenticated: true, ts: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' });
const authed = (req) => req.set('x-auth-token', AUTH_TOKEN);
const BASE = '/api/registry/agents';

function sample(id, tags) {
    return {
        id,
        name: 'Test ' + id,
        type: 'codex',
        capabilityTags: tags || ['code'],
        description: 'registry test agent',
        maxRounds: 10,
     };
}

describe('L2 Agent Registry API (P0 增量 2b)', () => {
    describe('GET /agents (read is public)', () => {
        it('returns 200 with agents+count', async () => {
            const res = await request(app).get(BASE);
            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('agents');
            expect(res.body).toHaveProperty('count');
        });
    });

    describe('POST /agents', () => {
        it('requires auth (401 without token)', async () => {
            const res = await request(app).post(BASE).send(sample('reg-noauth'));
            expect(res.status).toBe(401);
        });
        it('creates with auth (201, stamped specVersion)', async () => {
            const res = await authed(request(app).post(BASE)).send(sample('reg-create-1', ['code', 'writing']));
            expect(res.status).toBe(201);
            expect(res.body.id).toBe('reg-create-1');
            expect(res.body.specVersion).toBe('1.0.0');
            expect(res.body.capabilityTags).toEqual(['code', 'writing']);
        });
        it('rejects duplicate id (409)', async () => {
            const res = await authed(request(app).post(BASE)).send(sample('reg-create-1'));
            expect(res.status).toBe(409);
        });
        it('rejects invalid type (400, no stack leak)', async () => {
            const res = await authed(request(app).post(BASE)).send({ id: 'reg-bad', name: 'x', type: 'not-a-type', capabilityTags: [] });
            expect(res.status).toBe(400);
             // P0 安全风格：不暴露内部堆栈
            expect(JSON.stringify(res.body)).not.toContain('/Users/');
            expect(JSON.stringify(res.body)).not.toContain('at ');
         });
    });

    describe('GET /agents/:id 和 by-capability', () => {
        it('get by id (200)', async () => {
            const res = await request(app).get(BASE + '/reg-create-1');
            expect(res.status).toBe(200);
            expect(res.body.id).toBe('reg-create-1');
        });
        it('get missing id (404)', async () => {
            const res = await request(app).get(BASE + '/no-such-agent');
            expect(res.status).toBe(404);
        });
        it('by-capability returns matching agent', async () => {
            const res = await request(app).get('/api/registry/agents/by-capability/writing');
            expect(res.status).toBe(200);
            const ids = res.body.agents.map((a) => a.id);
            expect(ids).toContain('reg-create-1');
        });
    });

    describe('PUT / DELETE', () => {
        it('update (200)', async () => {
            const res = await authed(request(app).put(BASE + '/reg-create-1')).send({ maxRounds: 20 });
            expect(res.status).toBe(200);
            expect(res.body.maxRounds).toBe(20);
        });
        it('update missing id (404)', async () => {
            const res = await authed(request(app).put(BASE + '/ghost-agent')).send({ maxRounds: 1 });
            expect(res.status).toBe(404);
        });
        it('delete (200)', async () => {
            const res = await authed(request(app).delete(BASE + '/reg-create-1'));
            expect(res.status).toBe(200);
            expect(res.body.removed).toBe('reg-create-1');
        });
        it('delete missing id (404)', async () => {
            const res = await authed(request(app).delete(BASE + '/reg-create-1'));
            expect(res.status).toBe(404);
        });
    });
});
