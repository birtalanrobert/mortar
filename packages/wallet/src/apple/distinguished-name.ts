/**
 * Reading the attributes out of a subject or issuer line.
 *
 * Its own module with its own tests, because the two things that call it cannot
 * both be exercised by a fixture. Apple's certificates render as one attribute
 * per line; the development certificates this package generates render as a
 * single multi-valued name joined by ` + `, because `pkijs` flattens a parsed
 * name back into one relative name on the way out and cannot be made to do
 * otherwise. So the shape used in production is the shape no test could build,
 * and the only way to cover it honestly is to test the parser on the strings
 * themselves.
 *
 * The strings are Node's rendering of a distinguished name, which follows
 * RFC 4514: `\` escapes the characters that would otherwise separate things.
 */
export function parseDistinguishedName(rendered: string): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const line of rendered.split('\n')) {
    for (const part of line.split(/(?<!\\) \+ /)) {
      /*
       * The first `=` only: a value may contain one. `CN=Pass Type ID: pass.a=b`
       * is a legal common name and splitting on every `=` loses half of it.
       */
      const at = part.indexOf('=');
      if (at <= 0) continue;

      const type = part.slice(0, at).trim();
      const value = unescape(part.slice(at + 1).trim());

      /* First wins. A repeated attribute is unusual and the first is the specific one. */
      if (!attributes.has(type)) attributes.set(type, value);
    }
  }

  return attributes;
}

const unescape = (value: string): string => value.replace(/\\(.)/g, '$1');
