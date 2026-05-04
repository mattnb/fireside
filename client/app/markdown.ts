// client/app/markdown.ts
// Tiny markdown-to-HTML renderer used by the plan view and briefing detail.
// Supports: headings (h1-h3), bullet lists, fenced code blocks, paragraphs,
// inline code, and bold. Escapes HTML in user input.

export function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) return '<p class="empty-copy">no active plan recorded</p>';
  const html: string[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inList = false;
  let inCode = false;
  const closeList = (): void => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        html.push('</code></pre>');
        inCode = false;
      } else {
        closeList();
        html.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      html.push(
        `<h${heading[1]!.length}>${inlineMarkdown(heading[2]!)}</h${heading[1]!.length}>`,
      );
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(bullet[1]!)}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }
  closeList();
  if (inCode) html.push('</code></pre>');
  return html.join('');
}

function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
