/*
 * Copyright (c) 2026 Pingolin LLC
 * This file is part of Pingolin Note.
 *
 * Pingolin Note is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Pingolin Note is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Pingolin Note. If not, see <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Wiring, read from the source (the repo has no DOM tests; the rules
 * themselves are unit-tested in attachmentTrust.test.ts and
 * attachmentUpload.test.ts). What must not drift:
 *  - a blob opens only under blobKeysFor (the page) or the previous key alone
 *    (the re-key), never under a list that adds the retired keys;
 *  - the retired store is read only by the page's lazy opener and the export's
 *    filename list;
 *  - "seen" is marked only by an image's load, a video's play, and a download
 *    or shell save that started — never by the automatic preview load;
 *  - Keep hands over the held bytes with the metadata they opened with, and the
 *    note's CURRENT key; every re-seal goes through the one seal-and-swap;
 *  - the open note re-reads its list after a re-seal.
 */

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

/** `file: code` for every line matching `pattern`, comments aside. */
function uses(pattern: RegExp): string[] {
  return sources(SRC).flatMap((path) =>
    readFileSync(path, 'utf8').split('\n').flatMap((line) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*') || code.startsWith('{/*')) return [];
      return pattern.test(code) ? [`${relative(SRC, path)}: ${code}`] : [];
    }));
}

const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('which keys open an attachment', () => {
  it('a blob opens only under blobKeysFor on the page, and the previous key alone in the re-key', () => {
    expect(uses(/decryptResponse\(/).filter((u) => !/export async function decryptResponse\(/.test(u))).toEqual([
      'components/AttachmentButton.tsx: const dec = await decryptResponse(',
      'lib/attachmentUpload.ts: const dec = await decryptResponse([oldKey], resp);',
    ]);
    expect(read('components/AttachmentButton.tsx'))
      .toMatch(/const dec = await decryptResponse\(\n\s*blobKeysFor\(att\.opened, props\.contentKey\),\n/);
  });

  it('the retired store is read only by the page’s lazy opener and the export’s filename list', () => {
    expect(uses(/getRetained\(/).filter((u) => !/export function getRetained\(/.test(u))).toEqual([
      'components/AttachmentButton.tsx: const retired = () => (retained ??= getRetained(props.noteId));',
      'components/SettingsPanel.tsx: if (retained === null) retained = getRetained(n.id);',
    ]);
    // …and the re-key module does not even import it.
    expect(read('lib/attachmentUpload.ts')).not.toMatch(/retainedKeys/);
  });
});

describe('the flag', () => {
  it('a card is flagged exactly when its metadata opened only under a retired key, and shows the notice', () => {
    const src = read('components/AttachmentButton.tsx');
    expect(src).toMatch(/const opened = openAttachmentMeta\(att, props\.noteId, props\.contentKey, retired\);/);
    expect(src).toMatch(/blobUrl: blobs\[card\],\n\s*opened,\n\s*unconfirmed: opened\.unconfirmed,\n/);
    expect(src).toMatch(
      /<Show when=\{att\.unconfirmed\}>\n\s*<div class="notice-warning attachment-unconfirmed">\n\s*<div class="attachment-unconfirmed-title">\{UNCONFIRMED_ATTACHMENT_TITLE\}<\/div>\n\s*<div>\{UNCONFIRMED_ATTACHMENT_BODY\}<\/div>/,
    );
  });
});

describe('"seen" and "Keep file"', () => {
  it('seen is marked by an image load, a video play, a shell save handed over, and a download started — only', () => {
    // (sharesInbox has an unrelated markSeen of its own.)
    expect(uses(/markSeen\(/).filter((u) => /^components\/AttachmentButton/.test(u))).toEqual([
      'components/AttachmentButton.tsx: if (handed) { markSeen(att.card); return; }',
      'components/AttachmentButton.tsx: markSeen(att.card);',
      'components/AttachmentButton.tsx: onLoad={() => markSeen(att.card)}',
      'components/AttachmentButton.tsx: onPlay={() => markSeen(att.card)}',
    ]);
    const src = read('components/AttachmentButton.tsx');
    expect(src).toMatch(/a\.click\(\);\n\s*markSeen\(att\.card\);\n/);
    expect(src).toMatch(/<img\n\s*class="attachment-preview-img"[^\n]*\n\s*onLoad=\{\(\) => markSeen\(att\.card\)\}/);
    expect(src).toMatch(/<video\n\s*class="attachment-preview-video"[^\n]*\n\s*onPlay=\{\(\) => markSeen\(att\.card\)\}/);
  });

  it('Keep is offered from keepOffered on a flagged card, and hands over the held pair and the CURRENT key', () => {
    const src = read('components/AttachmentButton.tsx');
    expect(uses(/keepOffered\(/).filter((u) => /AttachmentButton/.test(u))).toEqual([
      'components/AttachmentButton.tsx: <Show when={keepOffered({ unconfirmed: att.unconfirmed, held: !!att.blobUrl, seen: !!seen()[att.card] })}>',
    ]);
    expect(uses(/handleKeep\(/)).toEqual([
      'components/AttachmentButton.tsx: <button class="btn" disabled={keeping() === att.card} onClick={() => handleKeep(att)}>',
    ]);
    expect(uses(/keepAttachment\(/).filter((u) => !/export async function keepAttachment\(/.test(u))).toEqual([
      'components/AttachmentButton.tsx: const ok = await keepAttachment({',
    ]);
    expect(src).toMatch(
      /const blob = blobObjects\[att\.card\];\n\s*const opened = heldMeta\[att\.card\];\n\s*const ok = await keepAttachment\(\{\n\s*noteId: props\.noteId,\n\s*attachmentId: att\.id,\n\s*seen: !!seen\(\)\[att\.card\],\n\s*held: blob && opened \? \{ blob, opened \} : undefined,\n\s*currentKey: props\.contentKey,\n\s*\}\);/,
    );
    // The pair is held together, from the load that opened those bytes.
    expect(src).toMatch(/blobObjects\[att\.card\] = blob;\n\s*if \(att\.opened\) heldMeta\[att\.card\] = att\.opened;/);
  });

  it('every re-seal goes through the one seal-and-swap', () => {
    expect(uses(/sealAndSwap\(/)).toEqual([
      'lib/attachmentUpload.ts: async function sealAndSwap(',
      'lib/attachmentUpload.ts: if (await sealAndSwap(noteId, att.id, dec.blob, metaJson, newKey)) {',
      'lib/attachmentUpload.ts: const ok = await sealAndSwap(k.noteId, k.attachmentId, k.held.blob, k.held.opened.json, k.currentKey);',
    ]);
    expect(uses(/rekeyAttachment\(/)).toEqual([
      'lib/attachmentUpload.ts: return rekeyAttachment(attachmentId, {',
      'lib/attachmentUpload.ts: export async function rekeyAttachment(',
    ]);
  });
});

describe('after a re-seal', () => {
  it('the open note re-reads its attachment list', () => {
    expect(read('components/NoteModal.tsx')).toMatch(
      /createEffect\(on\(attachmentsResealed, \(r\) => \{\n\s*if \(!r \|\| r\.noteId\.toLowerCase\(\) !== noteId\.toLowerCase\(\)\) return;\n\s*apiRequest<any\[\]>\(`\/api\/v1\/items\/\$\{noteId\}\/attachments`\)\.then\(res => \{\n\s*if \(res\.success\) setAttachments\(res\.data\);/,
    );
  });
});
