import type { ImageSet, PassAssets, PassContent, PassField } from '../content';
import { readPngSize } from './png';
import {
  ASSET_SIZES,
  BARCODE_FORMATS,
  DEFAULT_BARCODE_ENCODING,
  FIELD_LIMITS,
  MAX_LOCATIONS,
  MIN_AUTHENTICATION_TOKEN,
  STYLE_ASSETS,
  type PassProblem,
  type RuleName,
} from './rules';

/**
 * Checks a pass against {@link RULES} before it is signed.
 *
 * Every problem at once rather than the first — a caller fixing a pass wants the
 * list, and a test asserting a refusal wants to name the rule it expects rather
 * than the order the checks happen to run in.
 */
export function validateContent(content: PassContent): PassProblem[] {
  const problems: PassProblem[] = [];
  const add = (rule: RuleName, path: string, message: string) =>
    problems.push({ rule, path, message });

  for (const [key, value] of Object.entries({
    serialNumber: content.serialNumber,
    organizationName: content.organizationName,
    description: content.description,
  })) {
    if (!value || value.trim() === '') {
      add('requiredKeys', key, `${key} is required and must not be blank.`);
    }
  }

  for (const [name, colour] of Object.entries(content.colours)) {
    if (!colour) continue;
    for (const channel of ['r', 'g', 'b'] as const) {
      const level = (colour as Record<string, number | undefined>)[channel];
      if (level === undefined || !Number.isInteger(level) || level < 0 || level > 255) {
        add('colourSyntax', `colours.${name}.${channel}`, 'A colour channel is 0..255.');
      }
    }
  }

  problems.push(...validateFields(content));

  if (content.barcode) {
    if (!(content.barcode.format in BARCODE_FORMATS)) {
      add('barcodeFormat', 'barcode.format', `Unknown barcode format ${content.barcode.format}.`);
    }
    if (!content.barcode.message) {
      add('barcodeFormat', 'barcode.message', 'A barcode with no message scans as nothing.');
    }
    const encoding = content.barcode.encoding ?? DEFAULT_BARCODE_ENCODING;
    if (isLatin1(encoding) && !representableInLatin1(content.barcode.message)) {
      add(
        'barcodeEncodable',
        'barcode.message',
        `The message contains characters ${encoding} cannot carry. Keep barcode messages to ASCII, or set an encoding that can hold them.`,
      );
    }
  }

  if (content.locations && content.locations.length > MAX_LOCATIONS) {
    add(
      'locationCount',
      'locations',
      `A pass carries at most ${MAX_LOCATIONS} locations; this one has ${content.locations.length}.`,
    );
  }

  content.locations?.forEach((place, index) => {
    if (!Number.isFinite(place.latitude) || Math.abs(place.latitude) > 90) {
      add('locationRange', `locations[${index}].latitude`, 'Latitude is between -90 and 90.');
    }
    if (!Number.isFinite(place.longitude) || Math.abs(place.longitude) > 180) {
      add('locationRange', `locations[${index}].longitude`, 'Longitude is between -180 and 180.');
    }
  });

  if (content.webService) {
    if (!content.webService.url.startsWith('https://')) {
      add(
        'webServiceHttps',
        'webService.url',
        'The update web service must be HTTPS. A device will not call anything else.',
      );
    }
    if (content.webService.authenticationToken.length < MIN_AUTHENTICATION_TOKEN) {
      add(
        'authenticationTokenLength',
        'webService.authenticationToken',
        `An authentication token is at least ${MIN_AUTHENTICATION_TOKEN} characters; this one is ${content.webService.authenticationToken.length}.`,
      );
    }
  }

  problems.push(...validateAssets(content));

  return problems;
}

function validateFields(content: PassContent): PassProblem[] {
  const problems: PassProblem[] = [];
  const limits = FIELD_LIMITS[content.style];

  const groups: [keyof typeof limits | 'back', PassField[] | undefined][] = [
    ['header', content.header],
    ['primary', content.primary],
    ['secondary', content.secondary],
    ['auxiliary', content.auxiliary],
    ['back', content.back],
  ];

  const seen = new Map<string, string>();

  for (const [group, fields] of groups) {
    if (!fields?.length) continue;

    if (group !== 'back' && fields.length > limits[group]) {
      problems.push({
        rule: 'fieldCounts',
        path: `${group}`,
        message: `A ${content.style} shows at most ${limits[group]} ${group} field(s); this one has ${fields.length}. Apple drops the extras without saying so.`,
      });
    }

    fields.forEach((one, index) => {
      const path = `${group}[${index}]`;

      if (!one.key) {
        problems.push({ rule: 'fieldKeysUnique', path, message: 'Every field needs a key.' });
      } else if (seen.has(one.key)) {
        problems.push({
          rule: 'fieldKeysUnique',
          path: `${path}.key`,
          message: `The key "${one.key}" is already used by ${seen.get(one.key)}. Wallet diffs an update by key, so a duplicate updates the wrong field.`,
        });
      } else {
        seen.set(one.key, path);
      }

      if (one.changeMessage !== undefined && !one.changeMessage.includes('%@')) {
        problems.push({
          rule: 'changeMessagePlaceholder',
          path: `${path}.changeMessage`,
          message:
            'A changeMessage without %@ is never shown. It is the only way a pass speaks to its holder, so this fails rather than warns.',
        });
      }
    });
  }

  return problems;
}

/**
 * The images, checked for presence, format and the density relationship.
 *
 * The density check is the one that earns its place: an `@2x` that is not
 * exactly twice its base is scaled by the device rather than refused, so the
 * failure is a blurred logo on the newest phones and nothing at all in a log.
 */
export function validateAssets(content: PassContent): PassProblem[] {
  const problems: PassProblem[] = [];
  const assets = content.assets;

  if (!assets?.icon?.x1) {
    problems.push({
      rule: 'iconRequired',
      path: 'assets.icon',
      message: 'icon.png is required. Without it the pass installs and shows nothing.',
    });
  }

  for (const required of STYLE_ASSETS[content.style]) {
    if (!assets?.[required]?.x1) {
      problems.push({
        rule: 'styleAssets',
        path: `assets.${required}`,
        message: `A ${content.style} lays out around ${required}.png; without it the pass renders as an empty band.`,
      });
    }
  }

  for (const [name, set] of Object.entries(assets ?? {}) as [keyof PassAssets, ImageSet][]) {
    if (!set) continue;

    const base = readPngSize(set.x1);
    if (!base) {
      problems.push({
        rule: 'pngOnly',
        path: `assets.${name}`,
        message: `${name} is not a PNG. Pass images are PNG, whatever the file is called.`,
      });
      continue;
    }

    const expected = ASSET_SIZES[name];
    if (expected && (base.width > expected.width || base.height > expected.height)) {
      problems.push({
        rule: 'styleAssets',
        path: `assets.${name}`,
        message: `${name} is ${base.width}×${base.height}; the layout allows up to ${expected.width}×${expected.height}. Anything larger is scaled down on the device and reads as soft.`,
      });
    }

    for (const [density, multiple] of [
      ['x2', 2],
      ['x3', 3],
    ] as const) {
      const bytes = set[density];
      if (!bytes) continue;

      const size = readPngSize(bytes);
      if (!size) {
        problems.push({
          rule: 'pngOnly',
          path: `assets.${name}.${density}`,
          message: `${name}@${multiple}x is not a PNG.`,
        });
        continue;
      }

      if (size.width !== base.width * multiple || size.height !== base.height * multiple) {
        problems.push({
          rule: 'densityMultiples',
          path: `assets.${name}.${density}`,
          message: `${name}@${multiple}x is ${size.width}×${size.height}; it must be exactly ${base.width * multiple}×${base.height * multiple}.`,
        });
      }
    }
  }

  return problems;
}

const isLatin1 = (encoding: string): boolean =>
  /^(iso[-_]?8859[-_]?1|latin ?1|windows[-_]?1252)$/i.test(encoding.trim());

const representableInLatin1 = (value: string): boolean =>
  /* Every code point above 0xFF, and the C1 range a Latin-1 scanner will not show. */
  [...value].every((character) => character.codePointAt(0)! <= 0xff);

/**
 * The same rules, applied to a `pass.json` read out of an archive.
 *
 * Deliberately a second implementation over a different input rather than a
 * reuse of {@link validateContent}. That one checks the model we were handed;
 * this one checks the file that was actually written, which is the only thing a
 * device ever sees. A checker that inspects the builder's own intermediate state
 * agrees with the builder by construction and catches nothing.
 */
export function validatePassJson(passJson: unknown): PassProblem[] {
  const problems: PassProblem[] = [];
  const add = (rule: RuleName, path: string, message: string) =>
    problems.push({ rule, path, message });

  if (typeof passJson !== 'object' || passJson === null || Array.isArray(passJson)) {
    return [{ rule: 'requiredKeys', path: 'pass.json', message: 'pass.json is not an object.' }];
  }

  const pass = passJson as Record<string, unknown>;

  if (pass.formatVersion !== 1) {
    add(
      'formatVersion',
      'formatVersion',
      `formatVersion must be 1, not ${String(pass.formatVersion)}.`,
    );
  }

  for (const key of [
    'description',
    'organizationName',
    'passTypeIdentifier',
    'serialNumber',
    'teamIdentifier',
  ]) {
    const value = pass[key];
    if (typeof value !== 'string' || value.trim() === '') {
      add('requiredKeys', key, `${key} is required and must be a non-empty string.`);
    }
  }

  const styles = Object.keys(FIELD_LIMITS).filter((style) => style in pass);
  if (styles.length !== 1) {
    add(
      'singleStyle',
      'style',
      styles.length === 0
        ? 'A pass carries exactly one style key, and this one carries none.'
        : `A pass carries exactly one style key; this one carries ${styles.join(' and ')}.`,
    );
  }

  for (const key of ['backgroundColor', 'foregroundColor', 'labelColor', 'stripColor']) {
    const value = pass[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      !/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(value)
    ) {
      add('colourSyntax', key, `${key} must be an RGB triple such as rgb(23, 187, 82).`);
    }
  }

  const style = styles[0];
  if (style) {
    const limits = FIELD_LIMITS[style as keyof typeof FIELD_LIMITS];
    const groups = pass[style] as Record<string, unknown> | undefined;
    const seen = new Map<string, string>();

    for (const [group, limit] of [
      ['headerFields', limits.header],
      ['primaryFields', limits.primary],
      ['secondaryFields', limits.secondary],
      ['auxiliaryFields', limits.auxiliary],
      ['backFields', Number.POSITIVE_INFINITY],
    ] as const) {
      const fields = groups?.[group];
      if (fields === undefined) continue;

      if (!Array.isArray(fields)) {
        add('fieldCounts', `${style}.${group}`, `${group} must be an array.`);
        continue;
      }

      if (fields.length > limit) {
        add(
          'fieldCounts',
          `${style}.${group}`,
          `${group} holds at most ${limit} on a ${style}; this one has ${fields.length}.`,
        );
      }

      fields.forEach((one: unknown, index: number) => {
        const path = `${style}.${group}[${index}]`;
        const entry = (one ?? {}) as Record<string, unknown>;

        if (typeof entry.key !== 'string' || entry.key === '') {
          add('fieldKeysUnique', path, 'Every field needs a key.');
        } else if (seen.has(entry.key)) {
          add(
            'fieldKeysUnique',
            `${path}.key`,
            `The key "${entry.key}" is already used by ${seen.get(entry.key)}.`,
          );
        } else {
          seen.set(entry.key, path);
        }

        if (entry.value === undefined || entry.value === null) {
          add('requiredKeys', `${path}.value`, 'Every field needs a value.');
        }

        if (typeof entry.changeMessage === 'string' && !entry.changeMessage.includes('%@')) {
          add(
            'changeMessagePlaceholder',
            `${path}.changeMessage`,
            'A changeMessage without %@ is never shown.',
          );
        }
      });
    }
  }

  if ('barcode' in pass) {
    /*
     * Not a rule of Apple's — the singular key still works. It is a rule of
     * ours, and it is here rather than only in the renderer because this
     * function is what a hand-edited or third-party pass is checked with.
     */
    add(
      'barcodeFormat',
      'barcode',
      'The singular `barcode` key has been superseded by `barcodes` since iOS 9. Write only the plural.',
    );
  }

  const barcodes = pass.barcodes;
  if (barcodes !== undefined) {
    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      add('barcodeFormat', 'barcodes', 'barcodes must be a non-empty array.');
    } else {
      const formats = new Set<string>(Object.values(BARCODE_FORMATS));
      barcodes.forEach((one: unknown, index: number) => {
        const entry = (one ?? {}) as Record<string, unknown>;
        if (typeof entry.format !== 'string' || !formats.has(entry.format)) {
          add(
            'barcodeFormat',
            `barcodes[${index}].format`,
            `Unknown format ${String(entry.format)}.`,
          );
        }
        if (typeof entry.message !== 'string' || entry.message === '') {
          add('barcodeFormat', `barcodes[${index}].message`, 'A barcode needs a message.');
        }
        const encoding = entry.messageEncoding;
        if (typeof encoding !== 'string' || encoding === '') {
          add(
            'barcodeFormat',
            `barcodes[${index}].messageEncoding`,
            'A barcode needs an encoding.',
          );
        } else if (
          typeof entry.message === 'string' &&
          isLatin1(encoding) &&
          !representableInLatin1(entry.message)
        ) {
          add(
            'barcodeEncodable',
            `barcodes[${index}].message`,
            `The message contains characters ${encoding} cannot carry.`,
          );
        }
      });
    }
  }

  const locations = pass.locations;
  if (locations !== undefined) {
    if (!Array.isArray(locations)) {
      add('locationCount', 'locations', 'locations must be an array.');
    } else {
      if (locations.length > MAX_LOCATIONS) {
        add(
          'locationCount',
          'locations',
          `At most ${MAX_LOCATIONS} locations; this pass has ${locations.length}.`,
        );
      }
      locations.forEach((one: unknown, index: number) => {
        const place = (one ?? {}) as Record<string, unknown>;
        if (typeof place.latitude !== 'number' || Math.abs(place.latitude) > 90) {
          add('locationRange', `locations[${index}].latitude`, 'Latitude is between -90 and 90.');
        }
        if (typeof place.longitude !== 'number' || Math.abs(place.longitude) > 180) {
          add(
            'locationRange',
            `locations[${index}].longitude`,
            'Longitude is between -180 and 180.',
          );
        }
      });
    }
  }

  const url = pass.webServiceURL;
  const token = pass.authenticationToken;

  if (url !== undefined || token !== undefined) {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      add('webServiceHttps', 'webServiceURL', 'webServiceURL must be present and HTTPS.');
    }
    if (typeof token !== 'string' || token.length < MIN_AUTHENTICATION_TOKEN) {
      add(
        'authenticationTokenLength',
        'authenticationToken',
        `An authentication token is at least ${MIN_AUTHENTICATION_TOKEN} characters.`,
      );
    }
  }

  return problems;
}
