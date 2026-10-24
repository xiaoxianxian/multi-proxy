// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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

/* ── WCAG 对比度工具（P0-8）───────────────────────────────────────────────
   与其在测试里钉死十六进制色值（改一次色改一次测试，且挡不住"改回不达标的
   色"），这里钉的是「对比度 ≥ 阈值」：从 CSS 解析真实生效值，按 WCAG 2.1
   公式实测。色值可自由调，只要达标就绿；一旦调回不达标，测试自动红。 */

/** WCAG 2.1 相对亮度：L = 0.2126R + 0.7152G + 0.0722B（各通道先做 sRGB 线性化） */
function relLuminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  const lin = (c8) => {
    const s = c8 / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 对比度：ratio = (L_lighter + 0.05) / (L_darker + 0.05) */
function contrastRatio(fg, bg) {
  const a = relLuminance(fg);
  const b = relLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 提取指定选择器块的 CSS 体（大括号配平，避免吃到后续同名 :root 段） */
function extractBlock(css, selector) {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`CSS 选择器未找到: ${selector}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`大括号未配平: ${selector}`);
}

/** 把块内的 `--name: #hex;` 解析成 { name: hex } */
function parseVars(block) {
  const map = {};
  const re = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g;
  let m;
  while ((m = re.exec(block)) !== null) map[m[1]] = m[2];
  return map;
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

    // P0-1 修复后：完整旧色板除挂在 :root.dark（= html.dark）外，还挂了 html[data-theme="dark"]
    // 别名——各页的 data-theme 由 theme.js 统一设在 <html> 上，靠这条桥接才能让暗色真正生效。
    it('should define :root.dark selector', () => {
      expect(css).toContain(':root.dark');
      expect(css).toContain('html[data-theme="dark"]');
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
      expect(sharedCss).toContain('.sidebar {');
    });

    it('should define .sidebar-brand in dashboard styles', () => {
      // sidebar-brand is defined in shared-styles.css (design system)
      expect(sharedCss).toContain('.sidebar-brand');
    });

    it('should define .sidebar-nav in dashboard styles', () => {
      expect(sharedCss).toContain('.sidebar-nav');
    });

    it('should define .nav-item in dashboard styles', () => {
      expect(dashboardHtml).toContain('.nav-item');
    });

    it('should define .nav-item:hover state', () => {
      expect(sharedCss).toContain('.nav-item:hover');
    });

    it('should define .nav-item.active state', () => {
      expect(sharedCss).toContain('.nav-item.active');
    });

    it('should define .nav-section-label', () => {
      expect(sharedCss).toContain('.nav-section-label');
    });

    it('should define .sidebar-footer in dashboard styles', () => {
      expect(sharedCss).toContain('.sidebar-footer');
    });

    it('should define .mobile-menu-btn for responsive sidebar', () => {
      expect(sharedCss).toContain('.mobile-menu-btn');
    });

    it('should define .sidebar-overlay for mobile sidebar', () => {
      expect(sharedCss).toContain('.sidebar-overlay');
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
      // 同 P0-1：暗色覆盖同时挂 :root.dark 与 html[data-theme="dark"]
      expect(css).toContain(':root.dark');
      expect(css).toContain('.toggle-slider');
    });

    it('should define :root.dark .btn-outline', () => {
      expect(css).toContain(':root.dark');
      expect(css).toContain('.btn-outline');
    });

    it('should define :root.dark .toast', () => {
      expect(css).toContain(':root.dark');
      expect(css).toContain('.toast');
    });
  });

  describe('Responsive Design', () => {
    let sharedCss;
    let dashboardHtml;
    let logsHtml;
    beforeAll(() => {
      dashboardHtml = fs.readFileSync(
        path.join(CSS_DIR, 'dashboard.html'),
        'utf8'
      );
      sharedCss = readCss('shared-styles.css');
      logsHtml = fs.readFileSync(
        path.join(CSS_DIR, 'logs.html'),
        'utf8'
      );
    });

    it('should have @media query for max-width 768px in dashboard', () => {
      expect(sharedCss).toContain('@media (max-width: 768px)');
    });

    it('should hide sidebar and make it fixed on mobile in dashboard', () => {
      expect(sharedCss).toContain('position: fixed');
      expect(sharedCss).toContain('translateX(-100%)');
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
       if (name === 'consent.html') return; // 首启 overlay，内联样式（同 login/index 例）
        if (name === 'legal.html') return; // 法务页 overlay，内联样式（同 consent 例，自包含可达）
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

  describe('WCAG AA 文字对比度 (P0-8)', () => {
    // 两套色板并存（旧 --color-* 在 colors_and_type.css，新层在 tokens.css），
    // 且两套背景底不同，故两边都要按各自真实背景校验。
    const legacyCss = readCss('colors_and_type.css');
    const nextCss = readCss('tokens.css');
    const legacyLight = parseVars(extractBlock(legacyCss, ':root {'));
    // 选择器随 P0-1 修复改过：旧色板原本只挂在 :root.dark（= html.dark）下，而各页从不设
    // html.dark ⇒ 暗色永不生效。现在补了 data-theme 别名，故选择器变长。
    // 必须写完整选择器：文件上方的修复说明注释里也含 ":root.dark"，只写前缀会误匹配到注释。
    const legacyDark = parseVars(extractBlock(legacyCss, ':root.dark, html[data-theme="dark"] {'));
    const nextLight = parseVars(extractBlock(nextCss, ':root {'));
    const nextDark = parseVars(extractBlock(nextCss, 'html[data-theme="dark"]'));

    const LEGACY_BG = ['--color-bg', '--color-bg-secondary', '--color-bg-tertiary'];
    const NEXT_BG = ['--bg', '--surface', '--surface-2', '--surface-3'];

    /** 返回该前景在所有背景上的最差对比度，及其所在的底 */
    function worstOn(fg, bgNames, vars) {
      let worst = Infinity;
      let at = null;
      for (const bn of bgNames) {
        const r = contrastRatio(vars[fg], vars[bn]);
        if (r < worst) { worst = r; at = `${bn}=${vars[bn]}`; }
      }
      return { worst: Math.round(worst * 100) / 100, at };
    }

    const cases = [];
    const add = (layer, theme, fg, bgNames, vars, min) => {
      const { worst, at } = worstOn(fg, bgNames, vars);
      cases.push([`${layer}·${theme}`, fg, vars[fg], at, worst, min]);
    };

    // 正文级 token：WCAG AA 要求 ≥4.5:1
    ['--color-text', '--color-text-secondary', '--color-text-tertiary'].forEach((fg) => {
      add('旧色板', '浅色', fg, LEGACY_BG, legacyLight, 4.5);
      add('旧色板', '暗色', fg, LEGACY_BG, legacyDark, 4.5);
    });
    ['--fg', '--muted', '--subtle'].forEach((fg) => {
      add('新token', '浅色', fg, NEXT_BG, nextLight, 4.5);
      add('新token', '暗色', fg, NEXT_BG, nextDark, 4.5);
    });
    // --faint 语义为占位/时间戳/禁用（非正文），按 WCAG UI 组件级 ≥3:1 要求
    add('新token', '浅色', '--faint', NEXT_BG, nextLight, 3);
    add('新token', '暗色', '--faint', NEXT_BG, nextDark, 3);

    it.each(cases)(
      '%s %s = %s 在 %s 上最差对比度 %s 应 ≥ %s',
      (layer, fg, color, bgAt, ratio, min) => {
        expect(ratio).toBeGreaterThanOrEqual(min);
      }
    );

    it('每个被校验的 token 都应真实定义（防止改名后门禁被静默跳过）', () => {
      const required = [
        [legacyLight, LEGACY_BG.concat(['--color-text', '--color-text-secondary', '--color-text-tertiary'])],
        [legacyDark, LEGACY_BG.concat(['--color-text', '--color-text-secondary', '--color-text-tertiary'])],
        [nextLight, NEXT_BG.concat(['--fg', '--muted', '--subtle', '--faint'])],
        [nextDark, NEXT_BG.concat(['--fg', '--muted', '--subtle', '--faint'])],
      ];
      required.forEach(([vars, names]) => {
        names.forEach((n) => expect(vars[n]).toBeDefined());
      });
    });

    it('--faint 应按主题跨文件一致（colors_and_type 桥接段 vs tokens.css）', () => {
      // colors_and_type.css 底部的 v1 桥接段也定义了 --faint，而 tokens.css 后加载
      // 会覆盖它。两处若不一致，读代码看到的值和实际生效的值就对不上（漂移）。
      const bridgeLight = parseVars(extractBlock(legacyCss, '/* ===== v1 设计系统 token 桥接'));
      // 用完整选择器定位「桥接段」本身：现在文件里 html[data-theme="dark"] 出现了两处
      // （行 73 的完整旧色板别名 + 后段独立的桥接段），只写前缀会取错块。
      const bridgeDark = parseVars(extractBlock(legacyCss, 'html[data-theme="dark"], html.dark {'));
      expect(bridgeLight['--faint'].toLowerCase()).toBe(nextLight['--faint'].toLowerCase());
      expect(bridgeDark['--faint'].toLowerCase()).toBe(nextDark['--faint'].toLowerCase());
    });
  });
});
