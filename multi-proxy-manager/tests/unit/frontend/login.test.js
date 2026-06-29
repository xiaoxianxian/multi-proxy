/**
 * Login page tests
 * Verifies HTML structure, CSS classes, JS validation logic,
 * and backend auth API endpoints.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../../server');

const PUBLIC_DIR = path.join(__dirname, '../../../public');

function readHtml(filename) {
  return fs.readFileSync(path.join(PUBLIC_DIR, filename), 'utf8');
}

describe('Login Page', () => {

  describe('HTML Structure', () => {
    let html;
    beforeAll(() => { html = readHtml('login.html'); });

    it('should serve the login HTML page', () => {
      expect(html).toBeDefined();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Proxy Manager - Login');
    });

    it('should have brand section', () => {
      expect(html).toContain('class="branding"');
      expect(html).toContain('class="brand-name"');
      expect(html).toContain('Proxy Manager');
    });

    it('should have a card wrapper for forms', () => {
      expect(html).toContain('class="card"');
    });

    it('should have setup mode section', () => {
      expect(html).toContain('id="setupMode"');
      expect(html).toContain('form id="setupForm"');
      expect(html).toContain('setupPassword');
      expect(html).toContain('setupConfirm');
    });

    it('should have login mode section', () => {
      expect(html).toContain('id="loginMode"');
      expect(html).toContain('form id="loginForm"');
      expect(html).toContain('loginPassword');
    });

    it('should have message boxes for errors and success', () => {
      expect(html).toContain('id="setupError"');
      expect(html).toContain('id="setupSuccess"');
      expect(html).toContain('id="loginError"');
    });

    it('should have password strength indicator', () => {
      expect(html).toContain('id="strengthBars"');
      expect(html).toContain('id="strengthText"');
    });

    it('should have strength bars defined', () => {
      expect(html).toContain('class="strength-bar"');
    });

    it('should have rate limit info element', () => {
      expect(html).toContain('id="rateLimitInfo"');
    });

    it('should have forgot password modal', () => {
      expect(html).toContain('id="forgotModal"');
      expect(html).toContain('modal-overlay');
      expect(html).toContain('id="forgotModalTitle"');
    });

    it('should have password toggle buttons', () => {
      expect(html).toContain('class="password-toggle"');
      expect(html).toContain('eye-open');
      expect(html).toContain('eye-closed');
    });

    it('should have reset link for forgot password', () => {
      expect(html).toContain('id="resetLink"');
    });
  });

  describe('Password Validation Logic', () => {
    let html;
    beforeAll(() => { html = readHtml('login.html'); });

    it('should have password length check in setup form', () => {
      // Verify the JS validates password length >= 8
      expect(html).toContain('password.length < 8');
    });

    it('should have password match check in setup form', () => {
      expect(html).toContain('password !== confirm');
    });

    it('should have setup form submit handler', () => {
      expect(html).toContain('setupForm.addEventListener');
    });

    it('should have login form submit handler', () => {
      expect(html).toContain('loginForm.addEventListener');
    });
  });

  describe('Password Strength Calculator', () => {
    let html;
    beforeAll(() => { html = readHtml('login.html'); });

    it('should define calculateStrength function', () => {
      expect(html).toContain('function calculateStrength');
    });

    it('should evaluate minimum 8 chars', () => {
      expect(html).toContain('>= 8');
    });

    it('should evaluate 12+ chars bonus', () => {
      expect(html).toContain('>= 12');
    });

    it('should check upper and lower case together', () => {
      expect(html).toContain('[a-z]');
      expect(html).toContain('[A-Z]');
    });

    it('should check for digits', () => {
      expect(html).toContain('\\d');
    });

    it('should check for special characters', () => {
      expect(html).toContain('[^a-zA-Z0-9]');
    });

    it('should cap strength at 4', () => {
      expect(html).toContain('Math.min(score, 4)');
    });
  });

  describe('Rate Limiting Display', () => {
    let html;
    beforeAll(() => { html = readHtml('login.html'); });

    it('should define max attempts per minute constant', () => {
      expect(html).toContain('MAX_ATTEMPTS_PER_MINUTE');
    });

    it('should define lockout duration', () => {
      expect(html).toContain('LOCKOUT_DURATION_MS');
    });

    it('should have rate limit check function', () => {
      expect(html).toContain('function checkRateLimit');
    });

    it('should have rate limit recording', () => {
      expect(html).toContain('function recordAttempt');
    });
  });

  describe('Password Visibility Toggle', () => {
    let html;
    beforeAll(() => { html = readHtml('login.html'); });

    it('should toggle password field type between text and password', () => {
      expect(html).toContain("input.type = 'text'");
      expect(html).toContain("input.type = 'password'");
    });

    it('should toggle eye icon visibility', () => {
      expect(html).toContain('eyeOpen.style.display');
      expect(html).toContain('eyeClosed.style.display');
    });
  });

  describe('Forgot Password Modal', () => {
    let html;
    beforeAll(() => { html = readHtml('login.html'); });

    it('should have reset command steps', () => {
      expect(html).toContain('multi-proxy-password');
      expect(html).toContain('manage.sh restart manager');
    });

    it('should have copy command button', () => {
      expect(html).toContain('copyResetCommand');
      expect(html).toContain('clipboard.writeText');
    });

    it('should close modal on overlay click', () => {
      expect(html).toContain('e.target ===');
      expect(html).toContain('forgotModal.style.display = \'none\'');
    });

    it('should close modal on Escape key', () => {
      expect(html).toContain('e.key === \'Escape\'');
    });
  });

  describe('API Endpoints (supertest)', () => {
    it('should serve login HTML at /login', async () => {
      const res = await request(app).get('/login');
      expect(res.status).toBe(200);
      expect(res.text).toContain('login');
    });

    it('should return needsSetup and/or auth status from /api/auth/status', async () => {
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('needsSetup');
      // hasPassword may or may not be present depending on env config
      if (res.body.hasPassword !== undefined) {
        expect(typeof res.body.hasPassword).toBe('boolean');
      }
    });

    it('should reject POST /api/auth/login without password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });
});
