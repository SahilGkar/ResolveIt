/**
 * Shared HTML escaping for webview output.
 *
 * Every value rendered into a webview originates from project content, the file
 * system, or error text, so it is untrusted and must be escaped before it reaches
 * the DOM.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
