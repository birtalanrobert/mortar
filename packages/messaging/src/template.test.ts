import { describe, expect, it } from 'vitest';
import { placeholdersIn, renderTemplate, unknownPlaceholders } from './template';

describe('renderTemplate', () => {
  it('fills in what it was given', () => {
    const { text } = renderTemplate('Hello {{name}}, see you at {{when}}.', {
      name: 'Ana',
      when: '14:30',
    });

    expect(text).toBe('Hello Ana, see you at 14:30.');
  });

  it('tolerates spaces inside the braces', () => {
    // Somebody editing in a text box puts them there, and a template that
    // silently stops working because of a space is a template nobody trusts.
    expect(renderTemplate('Hello {{ name }}', { name: 'Ana' }).text).toBe('Hello Ana');
  });

  it('leaves a missing value empty rather than showing the placeholder', () => {
    const { text, missing } = renderTemplate('Hello {{name}}, at {{when}}.', { name: 'Ana' });

    /*
     * A customer reading "at {{when}}" learns that the business's software is
     * broken. One reading "at ." learns nothing, which is the better of two
     * bad outcomes — and the sender is told, which is where it can be fixed.
     */
    expect(text).toBe('Hello Ana, at .');
    expect(missing).toEqual(['when']);
  });

  it('treats an empty string as missing', () => {
    // A blank is not an answer. It renders the same either way; the difference
    // is whether anybody is told.
    expect(renderTemplate('Hello {{name}}', { name: '' }).missing).toEqual(['name']);
  });

  it('reports each missing name once, however often it appears', () => {
    expect(renderTemplate('{{a}} {{a}} {{b}}', {}).missing).toEqual(['a', 'b']);
  });

  it('renders a number without the caller having to convert it', () => {
    expect(renderTemplate('{{count}} minutes', { count: 30 }).text).toBe('30 minutes');
  });

  it('does not interpret anything but a name', () => {
    /*
     * No conditionals, no loops, no filters — because every one of those turns
     * a text box a shop owner edits into a language they can break. What looks
     * like syntax stays literal.
     */
    const { text } = renderTemplate('{{#if x}}yes{{/if}} {{ name }}', { name: 'Ana' });
    expect(text).toBe('{{#if x}}yes{{/if}} Ana');
  });

  it('does not substitute a value that itself looks like a placeholder', () => {
    // A customer called "{{name}}" is not a template. One pass, no rescanning.
    const { text } = renderTemplate('Hello {{name}}', { name: '{{when}}' });
    expect(text).toBe('Hello {{when}}');
  });
});

describe('placeholdersIn', () => {
  it('lists what a template asks for, once each', () => {
    expect(placeholdersIn('{{name}} {{when}} {{name}}')).toEqual(['name', 'when']);
  });

  it('finds nothing in a template with no placeholders', () => {
    expect(placeholdersIn('Your appointment is confirmed.')).toEqual([]);
  });
});

describe('unknownPlaceholders', () => {
  it('names what the product does not offer', () => {
    /*
     * The other half of an editor's job: a template referring to `{{stylist}}`
     * where the product supplies `{{staff}}` renders a message with a hole in
     * it, and the only moment anybody can notice is while it is being written.
     */
    expect(unknownPlaceholders('Hi {{name}}, with {{stylist}}', ['name', 'staff'])).toEqual([
      'stylist',
    ]);
  });

  it('is satisfied by a template that only uses what is offered', () => {
    expect(unknownPlaceholders('Hi {{name}}', ['name', 'when'])).toEqual([]);
  });
});
