/**
 * Pure HTML entity encoder — matches the browser DOM-based esc() in dashboard.html.
 * Used throughout the frontend to prevent XSS when injecting user content into HTML.
 */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { esc };
