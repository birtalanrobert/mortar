import { describe, expect, it } from 'vitest';
import { sampleAssets, sampleContent, solidPng } from '../testing';
import { buildPassJson } from './pass-json';
import type { RuleName } from './rules';
import { validateContent, validatePassJson } from './validate';

const rules = (problems: { rule: RuleName }[]) => problems.map((one) => one.rule);

const IDENTITY = { passTypeIdentifier: 'pass.test', teamIdentifier: 'TEAM123456' };

describe('a pass that is fine', () => {
  it('has nothing wrong with it, as content or as a file', () => {
    const content = sampleContent();

    expect(validateContent(content)).toEqual([]);
    expect(validatePassJson(buildPassJson(content, IDENTITY))).toEqual([]);
  });
});

describe('fields', () => {
  it('refuses two fields with the same key', () => {
    // Wallet diffs an update by key, so a duplicate updates whichever it finds.
    const problems = validateContent(
      sampleContent({
        secondary: [
          { key: 'member', value: 'Ana' },
          { key: 'member', value: 'Ion' },
        ],
      }),
    );

    expect(rules(problems)).toContain('fieldKeysUnique');
  });

  it('refuses a change message with no placeholder in it', () => {
    const problems = validateContent(
      sampleContent({
        primary: [{ key: 'reward', value: 'x', changeMessage: 'Something changed' }],
      }),
    );

    expect(rules(problems)).toContain('changeMessagePlaceholder');
  });

  it('refuses more primary fields than the layout shows', () => {
    /* Apple drops the extras silently, which is the reason this fails loudly. */
    const problems = validateContent(
      sampleContent({
        primary: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
      }),
    );

    expect(rules(problems)).toContain('fieldCounts');
  });

  it('lets a boarding pass have the two primary fields it is built around', () => {
    const problems = validateContent(
      sampleContent({
        style: 'boardingPass',
        primary: [
          { key: 'from', value: 'CLJ' },
          { key: 'to', value: 'OTP' },
        ],
      }),
    );

    expect(rules(problems)).not.toContain('fieldCounts');
  });

  it('does not limit the back of the pass, which scrolls', () => {
    const back = Array.from({ length: 20 }, (_, index) => ({
      key: `term-${index}`,
      value: 'A term.',
    }));

    expect(rules(validateContent(sampleContent({ back })))).not.toContain('fieldCounts');
  });
});

describe('the barcode', () => {
  it('refuses a message the declared encoding cannot carry', () => {
    /*
     * The default is iso-8859-1, which is what Apple's own examples use and what
     * counter hardware can be relied on to decode. A Romanian name in it is a
     * barcode that scans as something else or not at all.
     */
    const problems = validateContent(
      sampleContent({ barcode: { format: 'qr', message: 'ȘTAMPILĂ-123' } }),
    );

    expect(rules(problems)).toContain('barcodeEncodable');
  });

  it('accepts the same message when the encoding can hold it', () => {
    const problems = validateContent(
      sampleContent({ barcode: { format: 'qr', message: 'ȘTAMPILĂ-123', encoding: 'utf-8' } }),
    );

    expect(rules(problems)).not.toContain('barcodeEncodable');
  });

  it('writes only the plural key, and objects to the singular one', () => {
    const passJson = buildPassJson(sampleContent(), IDENTITY);

    expect(passJson.barcodes).toBeDefined();
    expect(passJson.barcode).toBeUndefined();

    expect(rules(validatePassJson({ ...passJson, barcode: { format: 'x' } }))).toContain(
      'barcodeFormat',
    );
  });
});

describe('locations', () => {
  it('refuses more than ten', () => {
    const locations = Array.from({ length: 11 }, () => ({ latitude: 46.7, longitude: 23.6 }));

    expect(rules(validateContent(sampleContent({ locations })))).toContain('locationCount');
  });

  it('refuses a transposed pair', () => {
    // Valid-looking, and it puts the pass somewhere in the ocean.
    const problems = validateContent(
      sampleContent({ locations: [{ latitude: 123.6, longitude: 46.7 }] }),
    );

    expect(rules(problems)).toContain('locationRange');
  });
});

describe('the update web service', () => {
  it('refuses anything but HTTPS', () => {
    const problems = validateContent(
      sampleContent({
        webService: { url: 'http://api.example/wallet', authenticationToken: 'x'.repeat(16) },
      }),
    );

    expect(rules(problems)).toContain('webServiceHttps');
  });

  it('refuses a token shorter than sixteen characters', () => {
    const problems = validateContent(
      sampleContent({
        webService: { url: 'https://api.example/wallet', authenticationToken: 'short' },
      }),
    );

    expect(rules(problems)).toContain('authenticationTokenLength');
  });

  it('refuses a token with no URL to send it to', () => {
    expect(rules(validatePassJson({ authenticationToken: 'x'.repeat(16) }))).toContain(
      'webServiceHttps',
    );
  });
});

describe('images', () => {
  it('requires an icon', () => {
    const problems = validateContent(
      sampleContent({ assets: { icon: undefined as never, strip: { x1: solidPng(375, 123) } } }),
    );

    expect(rules(problems)).toContain('iconRequired');
  });

  it('requires the image a store card is laid out around', () => {
    const problems = validateContent(sampleContent({ assets: { icon: { x1: solidPng(29, 29) } } }));

    expect(rules(problems)).toContain('styleAssets');
  });

  it('refuses a density that is not an exact multiple', () => {
    const assets = sampleAssets();
    assets.icon.x2 = solidPng(57, 58);

    expect(rules(validateContent(sampleContent({ assets })))).toContain('densityMultiples');
  });

  it('refuses something that is not a PNG whatever it is called', () => {
    const assets = sampleAssets();
    assets.logo = { x1: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') };

    expect(rules(validateContent(sampleContent({ assets })))).toContain('pngOnly');
  });

  it('refuses an image larger than the layout allows', () => {
    const assets = sampleAssets();
    assets.logo = { x1: solidPng(400, 200) };

    expect(rules(validateContent(sampleContent({ assets })))).toContain('styleAssets');
  });
});

describe('a pass.json that did not come from here', () => {
  it('refuses one with no style key and one with two', () => {
    expect(rules(validatePassJson({ formatVersion: 1 }))).toContain('singleStyle');
    expect(rules(validatePassJson({ formatVersion: 1, storeCard: {}, eventTicket: {} }))).toContain(
      'singleStyle',
    );
  });

  it('refuses a colour that is not an RGB triple', () => {
    const passJson = { ...buildPassJson(sampleContent(), IDENTITY), backgroundColor: '#183a2c' };

    expect(rules(validatePassJson(passJson))).toContain('colourSyntax');
  });

  it('refuses a format version that is not 1', () => {
    expect(
      rules(validatePassJson({ ...buildPassJson(sampleContent(), IDENTITY), formatVersion: 2 })),
    ).toContain('formatVersion');
  });

  it('refuses something that is not an object at all', () => {
    expect(rules(validatePassJson('a string'))).toEqual(['requiredKeys']);
  });
});
