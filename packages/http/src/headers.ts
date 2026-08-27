/**
 * Request identity and language, with no framework attached.
 *
 * Split out of the middleware so that a Next.js route handler, an edge
 * function or a job runner can read the same header names and negotiate the
 * same locale without importing `@nestjs/common`. The middleware that puts
 * them into the ambient context lives in `@birtalanrobert/http/nestjs`.
 */
export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export function negotiateLocale(
  header: string | undefined,
  supported: readonly string[],
  fallback: string,
): string {
  if (!header || supported.length === 0) return fallback;

  const accepted = header
    .split(',')
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(';');
      const quality = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)?.[1]).find(Boolean);
      return { tag: (tag ?? '').trim().toLowerCase(), quality: quality ? Number(quality) : 1 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  const supportedLower = supported.map((locale) => locale.toLowerCase());

  for (const { tag } of accepted) {
    if (tag === '*') return fallback;
    const exact = supportedLower.indexOf(tag);
    if (exact !== -1) return supported[exact] as string;

    const language = tag.split('-')[0];
    const byLanguage = supportedLower.findIndex(
      (locale) => locale === language || locale.split('-')[0] === language,
    );
    if (byLanguage !== -1) return supported[byLanguage] as string;
  }

  return fallback;
}
