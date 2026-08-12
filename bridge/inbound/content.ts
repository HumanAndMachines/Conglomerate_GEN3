// Zulip delivers rendered HTML in message.content. The runtime must receive
// human text and authenticated image bytes, not a private browser URL.

export interface NormalizedZulipContent {
  text: string;
  imageUrls: string[];
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, entity: string) => {
      if (entity[0] === "#") {
        const hex = entity[1]?.toLowerCase() === "x";
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return named[entity.toLowerCase()] ?? whole;
    },
  );
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  return match ? decodeEntities(match[1] ?? match[2] ?? "") : null;
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ""));
}

function isImageUpload(reference: string): boolean {
  try {
    const path = new URL(reference, "https://zulip.invalid").pathname;
    return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(path);
  } catch {
    return false;
  }
}

export function normalizeZulipContent(content: string): NormalizedZulipContent {
  const imageUrls: string[] = [];
  let rendered = content.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attribute(tag, "src");
    if (src && !imageUrls.includes(src)) imageUrls.push(src);
    return "";
  });
  // apply_markdown=false is deliberate in both the event queue and catch-up
  // API. Zulip therefore normally gives us its raw Markdown upload link.
  rendered = rendered.replace(
    /!?\[([^\]]*)\]\(((?:https?:\/\/[^\s)]+)?\/user_uploads\/[^\s)]+)\)/gi,
    (_whole, label: string, href: string) => {
      if (isImageUpload(href)) {
        if (!imageUrls.includes(href)) imageUrls.push(href);
        return label;
      }
      return `${label || href} (${href})`;
    },
  );


  rendered = rendered.replace(
    /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (whole, doubleQuoted: string, singleQuoted: string, body: string) => {
      const href = decodeEntities(doubleQuoted ?? singleQuoted ?? "");
      const label = stripTags(body).trim();
      if (imageUrls.includes(href)) return label;
      return href ? `${label || href} (${href})` : label || whole;
    },
  );
  rendered = rendered
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "");

  const text = decodeEntities(rendered)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, imageUrls };
}

export function isSessionResetCommand(text: string): boolean {
  return /^(?:\/reset|\/new)$/i.test(text.trim());
}

