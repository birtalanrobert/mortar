import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createZip, readZip } from './zip';

const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * Reads an archive back with nothing but the format.
 *
 * Deliberately not a library: a test that writes with one implementation and
 * reads with the same one proves the two agree, not that either is right. This
 * walks the central directory the way an extractor does.
 */
function read(archive: Buffer): Map<string, Buffer> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);

  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);

  // Buffers, not strings: half of what goes into these archives is binary, and
  // decoding it as UTF-8 changes its length.
  const files = new Map<string, Buffer>();

  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);

    const method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = archive.subarray(start, start + compressed);

    files.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

describe('createZip', () => {
  it('round-trips what was put into it', () => {
    const archive = createZip([
      { path: 'Popescu_Ion/01_Bank_statement.txt', content: bytes('statement') },
      { path: 'Popescu_Ion/02_Contract.txt', content: bytes('contract') },
    ]);

    const files = read(archive);
    expect(files.get('Popescu_Ion/01_Bank_statement.txt')?.toString('utf8')).toBe('statement');
    expect(files.get('Popescu_Ion/02_Contract.txt')?.toString('utf8')).toBe('contract');
  });

  it('is byte-identical for the same input', () => {
    const entries = [{ path: 'a.txt', content: bytes('the same bytes') }];

    // What lets a delivery retry produce a file the destination recognises as
    // the one it already has, rather than a second copy.
    expect(createZip(entries)).toEqual(createZip(entries));
  });

  it('compresses what compresses', () => {
    const repetitive = bytes('a'.repeat(10_000));

    const archive = createZip([{ path: 'a.txt', content: repetitive }]);

    expect(archive.length).toBeLessThan(1_000);
    expect(read(archive).get('a.txt')).toHaveLength(10_000);
  });

  it('stores what deflate would only make bigger', () => {
    // Incompressible, as a photograph or a PDF effectively is. Deflating adds
    // a few bytes, and paying for that is absurd. Genuinely random rather than
    // arithmetic: `(index * 7919) % 251` looks like noise and repeats every
    // 251 bytes, which deflate finds immediately.
    const noise = randomBytes(4096);

    const archive = createZip([{ path: 'photo.jpg', content: noise }]);

    // Method 0 in the local header: stored.
    expect(archive.readUInt16LE(8)).toBe(0);
    expect(read(archive).get('photo.jpg')).toEqual(noise);
  });

  it('can be told not to compress at all', () => {
    const archive = createZip([{ path: 'a.txt', content: bytes('a'.repeat(1000)) }], {
      store: true,
    });

    expect(archive.readUInt16LE(8)).toBe(0);
  });

  it('keeps a non-ASCII filename readable', () => {
    const archive = createZip([{ path: 'Ștefănescu/Extras de cont.txt', content: bytes('x') }]);

    // Bit 11 of the flags says the name is UTF-8. Without it an extractor reads
    // it in the machine's own code page and produces mojibake.
    expect(archive.readUInt16LE(6) & 0x0800).toBe(0x0800);
    expect([...read(archive).keys()]).toEqual(['Ștefănescu/Extras de cont.txt']);
  });

  it('refuses to write outside the directory it is extracted into', () => {
    const archive = createZip([
      { path: '/etc/passwd', content: bytes('x') },
      { path: '../../secrets.txt', content: bytes('y') },
    ]);

    // "Zip slip". Stripped here rather than relying on every extractor in the
    // world being careful about it.
    expect([...read(archive).keys()]).toEqual(['etc/passwd', 'secrets.txt']);
  });

  it('refuses two files at one path', () => {
    // Extractors disagree — overwrite, prompt, silently keep the first — so the
    // one thing that must not happen is for the extractor to decide.
    expect(() =>
      createZip([
        { path: 'a.txt', content: bytes('first') },
        { path: 'a.txt', content: bytes('second') },
      ]),
    ).toThrow(/share the path/);
  });

  it('refuses a path that is nothing but separators', () => {
    expect(() => createZip([{ path: '../..', content: bytes('x') }])).toThrow(/usable path/);
  });

  it('refuses an empty archive', () => {
    // A zero-file archive is a bug upstream — a delivery that thinks it packed
    // something. Better to fail here than to hand a firm an empty file.
    expect(() => createZip([])).toThrow(/at least one file/);
  });

  it('writes a timestamp an extractor can read', () => {
    const archive = createZip([{ path: 'a.txt', content: bytes('x') }], {
      modified: new Date('2026-08-20T14:30:00Z'),
    });

    const date = archive.readUInt16LE(12);
    expect(((date >> 9) & 0x7f) + 1980).toBe(2026);
    expect((date >> 5) & 0x0f).toBe(8);
  });

  it('clamps a date the format cannot represent', () => {
    // MS-DOS dates start in 1980. Wrapping would put a client's document in
    // 2076, which is the kind of wrong that survives for years.
    const archive = createZip([{ path: 'a.txt', content: bytes('x') }]);

    expect(archive.readUInt16LE(12)).toBe(0x0021);
  });

  it('produces an archive the operating system agrees is one', () => {
    const archive = createZip([
      { path: 'folder/one.txt', content: bytes('one') },
      { path: 'folder/two.txt', content: bytes('two') },
    ]);

    const directory = mkdtempSync(join(tmpdir(), 'mortar-zip-'));
    const file = join(directory, 'archive.zip');
    writeFileSync(file, archive);

    /*
     * The only assertion here that is not this file marking its own homework.
     * `unzip` is a different implementation by different people, and it is
     * roughly what the firm's own machine will use.
     */
    execFileSync('unzip', ['-q', file, '-d', directory]);

    expect(readFileSync(join(directory, 'folder/one.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(directory, 'folder/two.txt'), 'utf8')).toBe('two');
  });
});

describe('readZip', () => {
  it('reads back what createZip wrote, bytes intact', () => {
    const binary = randomBytes(5000);
    const archive = createZip([
      { path: 'pass.json', content: bytes('{"formatVersion":1}') },
      { path: 'strip@2x.png', content: binary },
      { path: 'ro.lproj/pass.strings', content: bytes('"a" = "b";\n') },
    ]);

    const files = readZip(archive);

    expect([...files.keys()].sort()).toEqual([
      'pass.json',
      'ro.lproj/pass.strings',
      'strip@2x.png',
    ]);
    expect(files.get('pass.json')!.toString('utf8')).toBe('{"formatVersion":1}');
    expect(files.get('strip@2x.png')!.equals(binary)).toBe(true);
  });

  /**
   * The assertion that stops this marking its own homework.
   *
   * A reader tested only against the writer beside it proves the two agree.
   * `zip` is a different implementation by different people, and it makes
   * choices ours does not — it stores what will not compress, writes its own
   * extra fields, and orders its central directory its own way.
   */
  it('reads an archive written by something else entirely', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mortar-zip-read-'));
    writeFileSync(join(directory, 'one.txt'), 'one');
    writeFileSync(join(directory, 'two.bin'), randomBytes(3000));
    execFileSync('zip', ['-q', '-r', 'made-elsewhere.zip', 'one.txt', 'two.bin'], {
      cwd: directory,
    });

    const files = readZip(readFileSync(join(directory, 'made-elsewhere.zip')));

    expect([...files.keys()].sort()).toEqual(['one.txt', 'two.bin']);
    expect(files.get('one.txt')!.toString('utf8')).toBe('one');
    expect(files.get('two.bin')!.equals(readFileSync(join(directory, 'two.bin')))).toBe(true);
  });

  it('reads a non-ASCII name the same way it wrote one', () => {
    const files = readZip(createZip([{ path: 'Ștefănescu/Extras.txt', content: bytes('x') }]));

    expect([...files.keys()]).toEqual(['Ștefănescu/Extras.txt']);
  });

  it('refuses something that is not an archive', () => {
    expect(() => readZip(randomBytes(2000))).toThrow(/not a ZIP archive/);
  });

  it('refuses an entry whose bytes have been altered', () => {
    const archive = createZip([{ path: 'manifest.json', content: bytes('a'.repeat(200)) }], {
      store: true,
    });

    /*
     * The whole reason a verifier reads the archive instead of asking the
     * builder: a byte changed after the fact has to be found in the file, and
     * the format already records enough to find it.
     */
    const tampered = Buffer.from(archive);
    tampered[60] = tampered[60]! ^ 0xff;

    expect(() => readZip(tampered)).toThrow(/checksum/);
  });

  it('refuses an encrypted entry rather than returning part of the archive', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mortar-zip-enc-'));
    writeFileSync(join(directory, 'secret.txt'), 'secret');
    execFileSync('zip', ['-q', '-P', 'hunter2', 'locked.zip', 'secret.txt'], { cwd: directory });

    // Skipping it would let a checker report on an archive it could not read.
    expect(() => readZip(readFileSync(join(directory, 'locked.zip')))).toThrow(/encrypted/);
  });
});
