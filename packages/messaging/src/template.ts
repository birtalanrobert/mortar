/**
 * What a message says, with the gaps filled in.
 *
 * **Pure, and at the root entry point on purpose.** A console renders a preview
 * on every keystroke while somebody edits a template, beside the live segment
 * count — and neither may drag a database driver into a browser bundle.
 *
 * The syntax is one thing and stays one thing: `{{name}}`. No conditionals, no
 * loops, no filters. Every one of those is a request that arrives eventually,
 * and every one turns a text box a shop owner edits into a programming language
 * they can break. What they actually need — "say the deposit line only when
 * there is a deposit" — is two templates, chosen by the code that knows.
 */

/** A name in double braces, with optional spaces: `{{ name }}`. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

export interface RenderResult {
  readonly text: string;
  /**
   * Placeholders the template asked for and the caller did not supply.
   *
   * Returned rather than thrown. A missing variable must not stop a
   * confirmation going out — an appointment time with one blank in it is worth
   * more to a customer than silence — but it is also exactly the mistake an
   * editor should be told about while they are still editing.
   */
  readonly missing: readonly string[];
}

/**
 * Fills a template in, and says what was not filled.
 *
 * An unsupplied placeholder is left **empty** rather than left as `{{name}}`.
 * A customer reading "Hello {{name}}" learns that the business's software is
 * broken; a customer reading "Hello" learns nothing, which is the better of
 * the two failures.
 */
export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, string | number | null | undefined>>,
): RenderResult {
  const missing: string[] = [];

  const text = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = variables[name];

    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }

    return String(value);
  });

  return { text, missing: [...new Set(missing)] };
}

/**
 * Every placeholder a template uses, in the order it uses them.
 *
 * For an editor: "this template can use {{name}}, {{when}} and {{business}}"
 * beside a box, so somebody does not have to guess and find out by sending.
 */
export function placeholdersIn(template: string): readonly string[] {
  const found = [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
  return [...new Set(found)];
}

/**
 * Placeholders a template uses that the product does not offer.
 *
 * The other half of the editor's job. A template referring to `{{stylist}}`
 * where the product supplies `{{staff}}` renders a message with a hole in it,
 * and the only moment anybody can notice is while it is being written.
 */
export function unknownPlaceholders(
  template: string,
  offered: readonly string[],
): readonly string[] {
  const known = new Set(offered);
  return placeholdersIn(template).filter((name) => !known.has(name));
}
