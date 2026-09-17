import { describe, expect, it } from 'vitest';
import { parseDistinguishedName } from './distinguished-name';

/**
 * Both renderings, because only one of them can ever come from a fixture.
 *
 * The newline form is what Apple's certificates produce and what production
 * reads; the ` + ` form is what this package's own development certificates
 * produce and what every other test in the suite exercises. A parser tested on
 * only the second is a parser tested on the case that does not matter.
 */
describe('parsing a distinguished name', () => {
  it('reads Apple’s shape: one attribute per line', () => {
    const subject = parseDistinguishedName(
      'UID=pass.ro.stamped.loyalty\nCN=Pass Type ID: pass.ro.stamped.loyalty\nOU=A1B2C3D4E5\nO=Stamped SRL\nC=RO',
    );

    expect(subject.get('CN')).toBe('Pass Type ID: pass.ro.stamped.loyalty');
    expect(subject.get('OU')).toBe('A1B2C3D4E5');
    expect(subject.get('O')).toBe('Stamped SRL');
  });

  it('reads a multi-valued name joined with a plus', () => {
    const subject = parseDistinguishedName(
      'CN=Pass Type ID: pass.test + OU=TEAM123456 + O=Development',
    );

    expect(subject.get('CN')).toBe('Pass Type ID: pass.test');
    expect(subject.get('OU')).toBe('TEAM123456');
    expect(subject.get('O')).toBe('Development');
  });

  it('keeps an equals sign that belongs to the value', () => {
    // A legal common name, and one that a split-on-every-equals parser halves.
    expect(parseDistinguishedName('CN=Pass Type ID: pass.a=b').get('CN')).toBe(
      'Pass Type ID: pass.a=b',
    );
  });

  it('keeps an escaped plus inside a value rather than splitting on it', () => {
    const subject = parseDistinguishedName('CN=Coffee \\+ Cake SRL\nOU=TEAM123456');

    expect(subject.get('CN')).toBe('Coffee + Cake SRL');
    expect(subject.get('OU')).toBe('TEAM123456');
  });

  it('ignores a line that is not an attribute', () => {
    expect([...parseDistinguishedName('\nCN=x\n   \n').keys()]).toEqual(['CN']);
  });
});
