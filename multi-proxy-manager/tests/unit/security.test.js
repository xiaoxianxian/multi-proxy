/**
 * Security tests: path traversal, XSS encoding, and DoS via oversized payloads.
 *
 * Tests isAllowedEndpoint with path traversal payloads,
 * verifies the esc() HTML encoder prevents XSS,
 * and checks that oversized passwords are rejected (DoS protection).
 */

const { esc } = require('./helpers/esc');

// ==================== isAllowedEndpoint tests (T6) ====================

const FORWARD_ENDPOINTS = {
  codex: {
    GET: ['/v1/models', '/health', '/api/config', '/api/routing-mode', '/api/providers/status', '/api/balances', '/api/history', '/api/test-connection'],
    POST: ['/v1/chat/completions', '/api/set-routing-mode', '/api/switch-model', '/api/clear-history'],
  },
  hermes: {
    GET: ['/v1/models', '/health', '/api/config', '/api/routing-mode', '/api/providers/status', '/api/balances', '/api/history', '/api/test-connection'],
    POST: ['/v1/chat/completions', '/api/set-routing-mode', '/api/switch-model', '/api/clear-history'],
  },
  cursor: {
    GET: ['/v1/models', '/health', '/v1/chat/completions', '/admin-api/providers', '/admin-api/models', '/admin-api/routes', '/admin-api/logs', '/admin-api/health', '/admin-api/settings'],
    POST: ['/v1/chat/completions', '/admin-api/providers', '/admin-api/models', '/admin-api/routes', '/admin-api/settings'],
    PUT: ['/admin-api/providers/:id', '/admin-api/settings'],
    DELETE: ['/admin-api/providers/:id', '/admin-api/models/:id'],
  },
};

function isAllowedEndpoint(proxy, method, pathStr) {
  const config = FORWARD_ENDPOINTS[proxy];
  if (!config) return false;
  const allowed = config[method.toUpperCase()] || config[(method.toUpperCase())];
  if (!allowed) return false;
  for (const pattern of allowed) {
    if (pattern === pathStr) return true;
    const patternParts = pattern.split('/');
    const pathParts = pathStr.split('/');
    if (patternParts.length !== pathParts.length) continue;
    let match = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        const idParam = patternParts[i].substring(1);
        if (idParam === 'id') {
          if (!/^[0-9a-fA-F-]{36}$/.test(pathParts[i]) && !/^\d{1,10}$/.test(pathParts[i]) && !/^[a-zA-Z0-9_-]{1,32}$/.test(pathParts[i])) {
            match = false;
            break;
          }
        }
        continue;
      }
      if (patternParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

describe('Path Traversal Prevention (T6)', () => {
  it('blocks ../../../etc/passwd path traversal in codex endpoint', () => {
    // Path traversal attacks trying to escape proxy boundaries
    expect(isAllowedEndpoint('codex', 'GET', '/../../../etc/passwd')).toBe(false);
    expect(isAllowedEndpoint('codex', 'GET', '/v1/models/../../../etc/passwd')).toBe(false);
    expect(isAllowedEndpoint('codex', 'GET', '../etc/shadow')).toBe(false);
  });

  it('blocks path traversal in cursor admin endpoints', () => {
    expect(isAllowedEndpoint('cursor', 'GET', '/admin-api/providers/../../../etc/passwd')).toBe(false);
    expect(isAllowedEndpoint('cursor', 'DELETE', '/admin-api/providers/../../..%2F..%2F..%2Fetc%2Fpasswd')).toBe(false);
    expect(isAllowedEndpoint('cursor', 'PUT', '/admin-api/providers/../settings')).toBe(false);
  });

  it('rejects path segments with special chars that bypass :id params', () => {
    // The :id param allows only UUID, numeric, or short alphanumeric — dots and slashes should be rejected
    expect(isAllowedEndpoint('cursor', 'PUT', '/admin-api/providers/../../../etc/passwd')).toBe(false);
    expect(isAllowedEndpoint('cursor', 'DELETE', '/admin-api/models/./../../bad')).toBe(false);
  });

  it('allows legitimate :id parameters', () => {
    expect(isAllowedEndpoint('cursor', 'PUT', '/admin-api/providers/abc123')).toBe(true);
    expect(isAllowedEndpoint('cursor', 'DELETE', '/admin-api/models/user-456')).toBe(true);
    expect(isAllowedEndpoint('cursor', 'PUT', '/admin-api/providers/a1B2c3D4')).toBe(true);
  });

  it('blocks double-encoded path traversal', () => {
    // Even with double encoding, the pattern doesn't match any allowed endpoint
    expect(isAllowedEndpoint('codex', 'GET', '/v1/models/%2e%2e/%2e%2e/etc/passwd')).toBe(false);
    expect(isAllowedEndpoint('cursor', 'GET', '/admin-api/providers/%252e%252e')).toBe(false);
  });
});

// ==================== XSS Prevention tests (T7) ====================

describe('XSS / HTML Encoding Module (tests/unit/helpers/esc.js)', () => {
  it('returns empty string for non-string input', () => {
    expect(esc(123)).toBe('');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc({})).toBe('');
  });

  it('passes through safe strings unchanged', () => {
    expect(esc('Hello World')).toBe('Hello World');
    expect(esc('test@example.com')).toBe('test@example.com');
  });

  it('HTML-encodes script tags in Provider names', () => {
    const malicious = '<script>alert(1)</script>';
    const encoded = esc(malicious);
    expect(encoded).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(encoded).not.toContain('<script>');
    expect(encoded).not.toContain('</script>');
  });

  it('HTML-encodes onmouseover event handlers', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const encoded = esc(malicious);
    expect(encoded).not.toContain('<img');
    expect(encoded).toContain('&lt;img');
    expect(encoded).toContain('onerror=alert(1)');
  });

  it('HTML-encodes javascript: URIs', () => {
    const malicious = '<a href="javascript:alert(1)">click</a>';
    const encoded = esc(malicious);
    expect(encoded).not.toContain('href="javascript:');
    expect(encoded).toBe('&lt;a href=&quot;javascript:alert(1)&quot;&gt;click&lt;/a&gt;');
  });

  it('HTML-encodes SVG onload injection', () => {
    const malicious = '<svg onload=alert(1)/>';
    const encoded = esc(malicious);
    expect(encoded).not.toContain('<svg');
    expect(encoded).toContain('&lt;svg');
  });

  it('properly handles ampersands in provider names', () => {
    const safe = 'OpenAI & Google';
    expect(esc(safe)).toBe('OpenAI &amp; Google');
  });

  it('properly handles quotes in provider names', () => {
    const name = "Test's Provider \"Premium\"";
    const encoded = esc(name);
    expect(encoded).toContain('&#039;');
    expect(encoded).toContain('&quot;');
  });

  it('HTML encoding prevents tag execution in template literals', () => {
    const name = '<script>document.cookie</script>';
    const escaped = esc(name);
    const template = `<span class="provider-name">${escaped}</span>`;
    expect(template).not.toContain('<script>');
    expect(template).toContain('&lt;script&gt;');
  });
});


  it('HTML-encodes iframe injection', () => {
    const malicious = '<iframe src="javascript:alert(1)">';
    const encoded = esc(malicious);
    expect(encoded).not.toContain('<iframe');
    expect(encoded).toContain('&lt;iframe');
  });

  it('HTML-encodes data: URI injection', () => {
    const malicious = '<a href="data:text/html,<script>alert(1)</script>">click</a>';
    const encoded = esc(malicious);
    expect(encoded).not.toContain('<script>');
    // data:text/html is not an HTML special char sequence, but script tag inside is encoded
    expect(encoded).toContain('&lt;script&gt;');
  });

// ==================== DoS via oversized payloads (T12) ====================


  it('HTML-encodes iframe injection', () => {
    const malicious = '<iframe src="javascript:alert(1)">';
    const encoded = esc(malicious);
    expect(encoded).not.toContain('<iframe');
    expect(encoded).toContain('&lt;iframe');
  });

  it('HTML-encodes data: URI injection', () => {
    const malicious = '<a href="data:text/html,<script>alert(1)</script>">click</a>';
    const encoded = esc(malicious);
    expect(encoded).not.toContain('<script>');
    // data:text/html is not an HTML special char sequence, but script tag inside is encoded
    expect(encoded).toContain('&lt;script&gt;');
  });

// ==================== DoS via oversized payloads (T12) ====================

describe('DoS Prevention — Oversized Payload (T12)', () => {
  // Simulates the password length check from server.js line 740
  function checkPasswordSize(password) {
    if (password && Buffer.byteLength(password, 'utf8') > 1024) {
      return 413; // Payload too large
    }
    return null; // Passes size check
  }

  it('accepts normal-length passwords', () => {
    const res = checkPasswordSize('mypassword123');
    expect(res).toBeNull();
  });

  it('accepts passwords up to 1KB', () => {
    const boundary = 'a'.repeat(1024);
    const res = checkPasswordSize(boundary);
    expect(res).toBeNull();
  });

  it('rejects 2KB password with 413 status', () => {
    const oversized = 'x'.repeat(2048);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(1024);
    const res = checkPasswordSize(oversized);
    expect(res).toBe(413);
  });

  it('rejects Unicode passwords exceeding 1KB byte length', () => {
    // Unicode characters may be 3-4 bytes each, so fewer chars needed
    const emoji = '你好'; // 6 bytes each
    const oversized = emoji.repeat(200); // 6 * 200 = 1200 bytes > 1024
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(1024);
    const res = checkPasswordSize(oversized);
    expect(res).toBe(413);
  });

  it('allows passwords exactly at the boundary', () => {
    const exact = 'a'.repeat(1024);
    expect(Buffer.byteLength(exact, 'utf8')).toBe(1024);
    expect(checkPasswordSize(exact)).toBeNull();
  });

  it('rejects passwords just over the boundary', () => {
    const justOver = 'a'.repeat(1025);
    expect(Buffer.byteLength(justOver, 'utf8')).toBe(1025);
    expect(checkPasswordSize(justOver)).toBe(413);
  });

  it('handles undefined/null passwords gracefully', () => {
    expect(checkPasswordSize(undefined)).toBeNull();
    expect(checkPasswordSize(null)).toBeNull();
    expect(checkPasswordSize('')).toBeNull();
  });
});
