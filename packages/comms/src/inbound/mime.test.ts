import { describe, expect, it } from 'vitest';
import { parseMime } from './mime';

/** Real messages use CRLF; a parser that only handles LF fails in production. */
const crlf = (lines: string[]) => lines.join('\r\n');

describe('parseMime', () => {
  it('reads the headers of a plain message', () => {
    const message = parseMime(
      crlf([
        'From: Ion Popescu <ion@example.com>',
        'To: docs+req-1.abc@in.example.com',
        'Subject: Documents',
        'Message-ID: <abc123@example.com>',
        'Date: Wed, 26 Aug 2026 09:00:00 +0000',
        '',
        'Here they are.',
      ]),
    );

    expect(message.from).toBe('ion@example.com');
    expect(message.to).toEqual(['docs+req-1.abc@in.example.com']);
    expect(message.subject).toBe('Documents');
    expect(message.messageId).toBe('abc123@example.com');
    expect(message.text).toBe('Here they are.');
    expect(message.receivedAt.toISOString()).toBe('2026-08-26T09:00:00.000Z');
  });

  it('handles a message with LF line endings', () => {
    const message = parseMime('From: a@example.com\nSubject: Hi\n\nBody here.');

    expect(message.subject).toBe('Hi');
    expect(message.text).toBe('Body here.');
  });

  it('collects every recipient, which is how a forward arrives', () => {
    const message = parseMime(
      crlf([
        'From: ion@example.com',
        'To: "Contabil" <contabil@example.com>, docs+req-1.abc@in.example.com',
        'Cc: sotia@example.com',
        '',
        'text',
      ]),
    );

    expect(message.to).toEqual(['contabil@example.com', 'docs+req-1.abc@in.example.com']);
    expect(message.cc).toEqual(['sotia@example.com']);
  });

  it('joins a folded header rather than losing it', () => {
    // A long Content-Type with a boundary usually arrives folded, and a
    // line-by-line parser loses the boundary and then finds no attachments.
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Subject: A subject that was',
        '  folded across two lines',
        '',
        'body',
      ]),
    );

    expect(message.subject).toBe('A subject that was folded across two lines');
  });

  it('decodes an encoded-word subject', () => {
    const encoded = Buffer.from('Situație financiară').toString('base64');
    const message = parseMime(
      crlf(['From: a@example.com', `Subject: =?UTF-8?B?${encoded}?=`, '', 'body']),
    );

    // In Romanian and Hungarian most subjects arrive this way.
    expect(message.subject).toBe('Situație financiară');
  });

  it('decodes a quoted-printable encoded word, where _ is a space', () => {
    const message = parseMime(
      crlf(['From: a@example.com', 'Subject: =?UTF-8?Q?Extras_de_cont?=', '', 'body']),
    );

    expect(message.subject).toBe('Extras de cont');
  });

  it('decodes a quoted-printable body', () => {
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Situa=C8=9Bie financiar=C4=83',
      ]),
    );

    expect(message.text).toBe('Situație financiară');
  });

  it('joins a soft line break, which encodes nothing', () => {
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'a very long line that the=',
        ' encoder wrapped',
      ]),
    );

    expect(message.text).toBe('a very long line that the encoder wrapped');
  });

  it('reads a body in a legacy charset', () => {
    // Older mail clients still send these, and reading them as UTF-8 produces
    // mojibake in the one place a person will read it.
    const body = Buffer.from([0x41, 0xe9]); // "Aé" in latin-1
    const message = parseMime(
      Buffer.concat([
        Buffer.from(
          crlf(['From: a@example.com', 'Content-Type: text/plain; charset=iso-8859-1', '', '']),
        ),
        body,
      ]),
    );

    expect(message.text).toBe('Aé');
  });

  it('pulls the text and the HTML out of a multipart/alternative', () => {
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: multipart/alternative; boundary="bnd"',
        '',
        '--bnd',
        'Content-Type: text/plain',
        '',
        'plain version',
        '--bnd',
        'Content-Type: text/html',
        '',
        '<p>html version</p>',
        '--bnd--',
      ]),
    );

    expect(message.text).toBe('plain version');
    expect(message.html).toBe('<p>html version</p>');
  });

  it('extracts a base64 attachment with its filename and bytes intact', () => {
    const pdf = Buffer.from('%PDF-1.7 fake but well-formed enough');
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: multipart/mixed; boundary="bnd"',
        '',
        '--bnd',
        'Content-Type: text/plain',
        '',
        'Attached.',
        '--bnd',
        'Content-Type: application/pdf; name="extras.pdf"',
        'Content-Disposition: attachment; filename="extras.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        pdf.toString('base64'),
        '--bnd--',
      ]),
    );

    expect(message.text).toBe('Attached.');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({
      filename: 'extras.pdf',
      contentType: 'application/pdf',
      inline: false,
    });
    // Byte-for-byte: this file is going to a professional who will open it.
    expect(message.attachments[0]?.content.equals(pdf)).toBe(true);
  });

  it('decodes a base64 attachment that the encoder wrapped', () => {
    const content = Buffer.alloc(300, 7);
    const wrapped = content.toString('base64').replace(/(.{76})/g, '$1\r\n');
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: multipart/mixed; boundary="bnd"',
        '',
        '--bnd',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="big.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        wrapped,
        '--bnd--',
      ]),
    );

    expect(message.attachments[0]?.content.equals(content)).toBe(true);
  });

  it('decodes an encoded-word filename', () => {
    const encoded = Buffer.from('Situație.pdf').toString('base64');
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: multipart/mixed; boundary="bnd"',
        '',
        '--bnd',
        'Content-Type: application/pdf',
        `Content-Disposition: attachment; filename="=?UTF-8?B?${encoded}?="`,
        '',
        'x',
        '--bnd--',
      ]),
    );

    expect(message.attachments[0]?.filename).toBe('Situație.pdf');
  });

  it('marks an inline image as inline rather than as a document', () => {
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: multipart/related; boundary="bnd"',
        '',
        '--bnd',
        'Content-Type: image/png',
        'Content-Disposition: inline; filename="signature.png"',
        'Content-ID: <sig@example.com>',
        '',
        'x',
        '--bnd--',
      ]),
    );

    // A signature graphic is not a document the client sent, and treating it
    // as one puts a logo on a bookkeeper's checklist.
    expect(message.attachments[0]).toMatchObject({ inline: true, contentId: 'sig@example.com' });
  });

  it('reads a nested multipart, which is how a forward of a forward arrives', () => {
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: multipart/mixed; boundary="outer"',
        '',
        '--outer',
        'Content-Type: multipart/alternative; boundary="inner"',
        '',
        '--inner',
        'Content-Type: text/plain',
        '',
        'inner text',
        '--inner--',
        '--outer',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="a.pdf"',
        '',
        'bytes',
        '--outer--',
      ]),
    );

    expect(message.text).toBe('inner text');
    expect(message.attachments).toHaveLength(1);
  });

  it('handles an unquoted boundary parameter', () => {
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: multipart/mixed; boundary=bnd',
        '',
        '--bnd',
        'Content-Type: text/plain',
        '',
        'body',
        '--bnd--',
      ]),
    );

    expect(message.text).toBe('body');
  });

  it('ignores the epilogue after the closing boundary', () => {
    const message = parseMime(
      crlf([
        'From: a@example.com',
        'Content-Type: multipart/mixed; boundary="bnd"',
        '',
        '--bnd',
        'Content-Type: text/plain',
        '',
        'body',
        '--bnd--',
        'this is not a part',
      ]),
    );

    expect(message.text).toBe('body');
    expect(message.attachments).toHaveLength(0);
  });

  it('does not fall over on a message with no body', () => {
    const message = parseMime(crlf(['From: a@example.com', 'Subject: Nothing']));

    expect(message.text).toBe('');
    expect(message.subject).toBe('Nothing');
  });

  it('does not fall over on nonsense', () => {
    // An inbound webhook receives whatever the internet sends it.
    const message = parseMime('not an email at all');

    expect(message.from).toBe('');
    expect(message.attachments).toEqual([]);
  });

  it('falls back to now when the date is unusable', () => {
    const before = Date.now();
    const message = parseMime(crlf(['From: a@example.com', 'Date: yesterday-ish', '', 'x']));

    expect(message.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('stops rather than recursing forever on a deeply nested message', () => {
    let body = 'deep';
    for (let depth = 30; depth > 0; depth -= 1) {
      body = crlf([
        `Content-Type: multipart/mixed; boundary="b${depth}"`,
        '',
        `--b${depth}`,
        body,
        `--b${depth}--`,
      ]);
    }

    expect(() => parseMime(crlf(['From: a@example.com', body]))).not.toThrow();
  });
});
