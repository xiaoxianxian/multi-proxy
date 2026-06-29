/**
 * Design system tests
 * Verifies CSS variables, button styles, toast styles, sidebar styles,
 * dark mode overrides, and responsive breakpoints across the design system CSS files.
 */

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '../../../public');

function readCss(filename) {
  return fs.readFileSync(path.join(CSS_DIR, filename), 'utf8');
}

describe('Design System', () => {

  describe('CSS Variable Definitions', () => {
    let css;
    beforeAll(() => { css = readCss('colors_and_type.css'); });

    it('should define root CSS variables', () => {
      expect(css).toContain(':root {');
    });

    it('should define primary color', () => {
      expect(css).toContain('--color-primary');
      expect(css).toContain('#2563eb');
    });

    it('should define primary hover color', () => {
      expect(css).toContain('--color-primary-hover');
    });

    it('should define primary light color', () => {
      expect(css).toContain('--color-primary-light');
    });

    it('should define success color', () => {
      expect(css).toContain('--color-success');
      expect(css).toContain('#10b981');
    });

    it('should define success light variant', () => {
      expect(css).toContain('--color-success-light');
    });

    it('should define warning color', () => {
      expect(css).toContain('--color-warning');
      expect(css).toContain('#f59e0b');
    });

    it('should define warning light variant', () => {
      expect(css).toContain('--color-warning-light');
    });

    it('should define error color', () => {
      expect(css).toContain('--color-error');
      expect(css).toContain('#ef4444');
    });

    it('should define error light variant', () => {
      expect(css).toContain('--color-error-light');
    });

    it('should define info color', () => {
      expect(css).toContain('--color-info');
      expect(css).toContain('#3b82f6');
    });

    it('should define info light variant', () => {
      expect(css).toContain('--color-info-light');
    });

    it('should define background colors', () => {
      expect(css).toContain('--color-bg');
      expect(css).toContain('--color-bg-secondary');
      expect(css).toContain('--color-bg-tertiary');
    });

    it('should define border colors', () => {
      expect(css).toContain('--color-border');
      expect(css).toContain('--color-border-light');
    });

    it('should define text colors', () => {
      expect(css).toContain('--color-text');
      expect(css).toContain('--color-text-secondary');
      expect(css).toContain('--color-text-tertiary');
    });

    it('should define font families', () => {
      expect(css).toContain('--font-family');
      expect(css).toContain('--font-mono');
    });

    it('should define Inter as primary font', () => {
      expect(css).toContain('Inter');
    });

    it('should define JetBrains Mono as monospace font', () => {
      expect(css).toContain('JetBrains Mono');
    });

    it('should define border radii', () => {
      expect(css).toContain('--radius-sm');
      expect(css).toContain('--radius-md');
      expect(css).toContain('--radius-lg');
    });

    it('should define shadows', () => {
      expect(css).toContain('--shadow-sm');
      expect(css).toContain('--shadow-md');
      expect(css).toContain('--shadow-lg');
    });

    it('should define transition durations', () => {
      expect(css).toContain('--transition-fast');
      expect(css).toContain('--transition-normal');
    });

    it('should define sidebar width', () => {
      expect(css).toContain('--sidebar-width');
    });

    it('should define main padding', () => {
      expect(css).toContain('--main-padding');
    });
  });

  describe('Dark Mode CSS Variables', () => {
    let css;
    beforeAll(() => { css = readCss('colors_and_type.css'); });

    it('should define :root.dark selector', () => {
      expect(css).toContain(':root.dark {');
    });

    it('should override primary color for dark mode', () => {
      expect(css).toContain('dark');
      expect(css).toContain('--color-primary');
    });

    it('should override background for dark mode', () => {
      expect(css).toContain('--color-bg: #0f172a');
    });

    it('should override secondary background for dark mode', () => {
      expect(css).toContain('--color-bg-secondary');
    });

    it('should override text color for dark mode', () => {
      expect(css).toContain('--color-text: #f1f5f9');
    });

    it('should override border color for dark mode', () => {
      expect(css).toContain('--color-border');
    });
  });

  describe('Button Style Classes', () => {
    let css;
    beforeAll(() => { css = readCss('shared-styles.css'); });

    it('should define .btn base class', () => {
      expect(css).toContain('.btn {');
    });

    it('should define .btn-primary class', () => {
      expect(css).toContain('.btn-primary {');
    });

    it('should define .btn-outline class', () => {
      expect(css).toContain('.btn-outline {');
    });

    it('should define .btn-danger class', () => {
      expect(css).toContain('.btn-danger {');
    });

    it('should define .btn-success class', () => {
      expect(css).toContain('.btn-success {');
    });

    it('should define .btn-sm class', () => {
      expect(css).toContain('.btn-sm {');
    });

    it('should define .btn:disabled state', () => {
      expect(css).toContain('.btn:disabled');
    });

    it('should define hover state for .btn', () => {
      expect(css).toContain('.btn:hover');
    });
  });

  describe('Toast Style Classes', () => {
    let css;
    beforeAll(() => { css = readCss('shared-styles.css'); });

    it('should define .toast-container', () => {
      expect(css).toContain('.toast-container');
    });

    it('should define .toast base class', () => {
      expect(css).toContain('.toast {');
    });

    it('should define .toast.success variant', () => {
      expect(css).toContain('.toast.success');
    });

    it('should define .toast.error variant', () => {
      expect(css).toContain('.toast.error');
    });

    it('should define .toast.info variant', () => {
      expect(css).toContain('.toast.info');
    });

    it('should define .toast.warning variant', () => {
      expect(css).toContain('.toast.warning');
    });

    it('should define toast-in animation', () => {
      expect(css).toContain('@keyframes toast-in');
    });

    it('should define toast-out animation', () => {
      expect(css).toContain('@keyframes toast-out');
    });

    it('should have high z-index for toast container', () => {
      expect(css).toContain('99999');
    });
  });

  describe('Sidebar Styles', () => {
    let sharedCss;
    let dashboardHtml;
    beforeAll(() => {
      sharedCss = readCss('shared-styles.css');
      // Dashboard HTML contains inline sidebar styles too
      dashboardHtml = fs.readFileSync(
        path.join(CSS_DIR, 'dashboard.html'),
        'utf8'
      );
    });

    it('should define .sidebar-class in dashboard styles', () => {
      // Dashboard has inline .sidebar styles
      expect(dashboardHtml).toContain('.sidebar {');
    });

    it('should define sidebar-header in dashboard styles', () => {
      expect(dashboardHtml).toContain('.sidebar-header');
    });

    it('should define .sidebar-nav in dashboard styles', () => {
      expect(dashboardHtml).toContain('.sidebar-nav');
    });

    it('should define .nav-item in dashboard styles', () => {
      expect(dashboardHtml).toContain('.nav-item');
    });

    it('should define .nav-item:hover state', () => {
      expect(dashboardHtml).toContain('.nav-item:hover');
    });

    it('should define .nav-item.active state', () => {
      expect(dashboardHtml).toContain('.nav-item.active');
    });

    it('should define .nav-section-label', () => {
      expect(dashboardHtml).toContain('.nav-section-label');
    });

    it('should define .sidebar-footer in dashboard styles', () => {
      expect(dashboardHtml).toContain('.sidebar-footer');
    });

    it('should define .mobile-menu-btn for responsive sidebar', () => {
      expect(dashboardHtml).toContain('.mobile-menu-btn');
    });

    it('should define .sidebar-overlay for mobile sidebar', () => {
      expect(dashboardHtml).toContain('.sidebar-overlay');
    });
  });

  describe('Shared Button Classes in HTML Pages', () => {
    let html;
    beforeAll(() => { html = readCss('shared-styles.css'); });

    it('should define .form-select class', () => {
      expect(html).toContain('.form-select');
    });

    it('should define .form-input class', () => {
      expect(html).toContain('.form-input');
    });

    it('should define .status-badge class', () => {
      expect(html).toContain('.status-badge');
    });

    it('should define .status-badge.online variant', () => {
      expect(html).toContain('.status-badge.online');
    });

    it('should define .status-badge.offline variant', () => {
      expect(html).toContain('.status-badge.offline');
    });

    it('should define .toggle switch class', () => {
      expect(html).toContain('.toggle');
    });
  });

  describe('Dark Mode Overrides in Shared CSS', () => {
    let css;
    beforeAll(() => { css = readCss('shared-styles.css'); });

    it('should define :root.dark .toggle-slider', () => {
      expect(css).toContain(':root.dark .toggle-slider');
    });

    it('should define :root.dark .btn-outline', () => {
      expect(css).toContain(':root.dark .btn-outline');
    });

    it('should define :root.dark .toast', () => {
      expect(css).toContain(':root.dark .toast');
    });
  });

  describe('Responsive Design', () => {
    let dashboardHtml;
    let logsHtml;
    beforeAll(() => {
      dashboardHtml = fs.readFileSync(
        path.join(CSS_DIR, 'dashboard.html'),
        'utf8'
      );
      logsHtml = fs.readFileSync(
        path.join(CSS_DIR, 'logs.html'),
        'utf8'
      );
    });

    it('should have @media query for max-width 768px in dashboard', () => {
      expect(dashboardHtml).toContain('@media (max-width: 768px)');
    });

    it('should hide sidebar and make it fixed on mobile in dashboard', () => {
      expect(dashboardHtml).toContain('position: fixed');
      expect(dashboardHtml).toContain('translateX(-100%)');
    });

    it('should show mobile menu button on small screens in dashboard', () => {
      expect(dashboardHtml).toContain('display: flex');
      expect(dashboardHtml).toContain('mobile-menu-btn');
    });

    it('should collapse stat grid to single column on mobile in dashboard', () => {
      expect(dashboardHtml).toContain('grid-template-columns: 1fr');
    });

    it('should have reduced motion media query in dashboard', () => {
      expect(dashboardHtml).toContain('prefers-reduced-motion');
    });

    it('should have @media query for max-width 768px in logs', () => {
      expect(logsHtml).toContain('@media (max-width: 768px)');
    });

    it('should have @media query for max-width 480px in login', () => {
      let loginHtml = fs.readFileSync(
        path.join(CSS_DIR, 'login.html'),
        'utf8'
      );
      expect(loginHtml).toContain('@media (max-width: 480px)');
    });
  });

  describe('CSS Architecture Consistency', () => {
    let sharedCss;
    beforeAll(() => { sharedCss = readCss('shared-styles.css'); });

    it('should use consistent CSS variable prefix --color-', () => {
      // Verify shared CSS follows the color variable convention
      const colorMatches = sharedCss.match(/--color-\w+/g) || [];
      expect(colorMatches.length).toBeGreaterThan(0);
    });

    it('should use consistent CSS variable prefix --radius-', () => {
      const radiusMatches = sharedCss.match(/--radius-\w+/g) || [];
      expect(radiusMatches.length).toBeGreaterThan(0);
    });

    it('should use consistent CSS variable prefix --font-', () => {
      const fontMatches = sharedCss.match(/--font-\w+/g) || [];
      expect(fontMatches.length).toBeGreaterThan(0);
    });

    it('should use consistent CSS variable prefix --shadow-', () => {
      const shadowMatches = sharedCss.match(/--shadow-\w+/g) || [];
      expect(shadowMatches.length).toBeGreaterThan(0);
    });

    it('should use consistent CSS variable prefix --transition-', () => {
      const transMatches = sharedCss.match(/--transition-\w+/g) || [];
      expect(transMatches.length).toBeGreaterThan(0);
    });
  });

  describe('All Pages Share CSS', () => {
    let filenames;
    beforeAll(() => {
      filenames = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.html'));
    });

    it('should reference colors_and_type.css in all HTML pages', () => {
      filenames.forEach(name => {
        if (name === 'index.html') return; // redirect page, no CSS
        if (name === 'login.html') return; // inline styles, no external CSS
        const content = fs.readFileSync(path.join(CSS_DIR, name), 'utf8');
        expect(content).toContain('colors_and_type.css');
      });
    });

    it('should reference shared-styles.css in applicable pages', () => {
      // dashboard.html, logs.html, proxy-config.html should reference it
      ['dashboard.html', 'logs.html', 'proxy-config.html'].forEach(name => {
        const content = fs.readFileSync(path.join(CSS_DIR, name), 'utf8');
        expect(content).toContain('shared-styles.css');
      });
    });
  });
});
