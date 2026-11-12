import { Fragment, type ReactNode } from 'react';

// Agent replies use WhatsApp-style formatting: *bold* (or Markdown's **bold**), bare links,
// and a line with only "---" to split a reply into separate bubbles.

const TOKEN = /(https?:\/\/[^\s<>"]+|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
const TRAILING_PUNCTUATION = /[.,!?;:)\]]+$/;

/** Splits a reply into bubbles on "---" lines. */
export function splitBubbles(text: string): string[] {
  return text
    .split(/^\s*---\s*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** One bubble's text with *bold* / **bold** and clickable links. Line breaks are kept by CSS (pre-wrap). */
export function formatText(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const token = match[0];
    if (token.startsWith('*')) {
      const stars = token.startsWith('**') ? 2 : 1;
      out.push(<strong key={i++}>{token.slice(stars, -stars)}</strong>);
      last = start + token.length;
      continue;
    }
    const url = token.replace(TRAILING_PUNCTUATION, '');
    out.push(
      <a key={i++} href={url} target="_blank" rel="noopener noreferrer">
        {url.replace(/^https?:\/\/(www\.)?/, '')}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <Fragment>{out}</Fragment>;
}
