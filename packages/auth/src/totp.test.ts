import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normaliseRecoveryCode,
} from './recovery-codes';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotpStep,
  otpauthUri,
  totpCode,
  totpStep,
} from './totp';

describe('time-based one-time passwords', () => {
  /*
   * RFC 6238's own test vectors (Appendix B), for HMAC-SHA1 with its 20-byte
   * key and eight digits: an implementation that disagrees with any of these
   * shows codes no authenticator app agrees with.
   */
  const rfcKey = Buffer.from('12345678901234567890', 'ascii');
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  it('agrees with RFC 6238’s test vectors', () => {
    for (const [seconds, code] of vectors) {
      expect(totpCode(rfcKey, totpStep(seconds * 1000), 8)).toBe(code);
    }
  });

  it('accepts a code for the step before or after, and nothing further or malformed', () => {
    const at = 1_234_567_890_000;
    const step = totpStep(at);
    const code = (offset: number) => totpCode(rfcKey, step + offset);
    expect(matchTotpStep(rfcKey, code(0), at)).toBe(step);
    expect(matchTotpStep(rfcKey, code(-1), at)).toBe(step - 1);
    expect(matchTotpStep(rfcKey, code(1), at)).toBe(step + 1);
    expect(matchTotpStep(rfcKey, code(2), at)).toBeNull();
    expect(matchTotpStep(rfcKey, code(-2), at)).toBeNull();
    // Typed with a space, as some apps show it.
    expect(matchTotpStep(rfcKey, `${code(0).slice(0, 3)} ${code(0).slice(3)}`, at)).toBe(step);
    expect(matchTotpStep(rfcKey, '12345', at)).toBeNull();
    expect(matchTotpStep(rfcKey, 'abcdef', at)).toBeNull();
  });

  it('writes keys in RFC 4648 base32 and reads them back, forgiving how they were copied', () => {
    // RFC 4648's test vectors, unpadded.
    const cases: Array<[string, string]> = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of cases) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    }
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow();

    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('gives an app its enrolment as the link every app reads', () => {
    expect(
      otpauthUri({ issuer: 'Holdfast', account: 'Ada Lovelace', secret: 'JBSWY3DPEHPK3PXP' }),
    ).toBe(
      'otpauth://totp/Holdfast:Ada%20Lovelace?secret=JBSWY3DPEHPK3PXP&issuer=Holdfast' +
        '&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('recovery codes', () => {
  it('are ten, each two groups of five from an alphabet nothing in reads as something else', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-hjkmnp-tw-z2-9]{5}-[a-hjkmnp-tw-z2-9]{5}$/);
  });

  it('are compared as typed — case, spaces and dash forgiven — and kept only as a hash', () => {
    const [code] = generateRecoveryCodes(1);
    expect(normaliseRecoveryCode(` ${code!.toUpperCase()} `)).toBe(code!.replace('-', ''));
    expect(hashRecoveryCode(code!.toUpperCase())).toBe(hashRecoveryCode(code!));
    expect(hashRecoveryCode(code!)).toMatch(/^[0-9a-f]{64}$/);
    expect(looksLikeRecoveryCode(code!)).toBe(true);
    // An app's six digits are never taken for one.
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });
});
