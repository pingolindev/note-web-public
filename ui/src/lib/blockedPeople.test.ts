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
import { readFileSync } from 'fs';
import { join } from 'path';
import { BLOCKED_PEOPLE, addressToBlock, blockedListView, inListOrder, isFrom, listAsKnown, readAfterAction, type Settled } from './blockedPeople';

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

/**
 * The wording, pinned letter for letter: user-facing copy only changes
 * deliberately, together with this test.
 */
describe('the words of "Blocked people"', () => {
  it('are exactly these', () => {
    expect(BLOCKED_PEOPLE).toEqual({
      title: 'Blocked people',
      description: "People you block can't share notes or notebooks with you, even after changing their email address. They are not notified.",
      fieldLabel: 'Email address',
      block: 'Block',
      unblock: 'Unblock',
      empty: "You haven't blocked anyone.",
    });
  });

  it('say "They are not notified.", not "aren\'t told"', () => {
    expect(BLOCKED_PEOPLE.description).toContain('They are not notified.');
    expect(BLOCKED_PEOPLE.description).not.toContain("aren't told");
  });

  /**
   * Asked inline at each place, as every confirmation is
   * (lib/confirmDialogUsage.test counts them): the invitation's is the note
   * card's, word for word.
   */
  it('the question before a block is the note card\'s, word for word, in both places', () => {
    const asked = `    if (!(await confirmAction({
      message: \`Block \${email}?\`,
      detail: "Their shared notes will be removed from your inbox and you won't receive future shares from them. You can unblock them later in Settings.",
      confirmLabel: 'Block sender',
      destructive: true,
    }))) return;`;
    expect(read('pages', 'NotesView.tsx')).toContain(asked);
    expect(read('components', 'SharedNotebooks.tsx')).toContain(asked);
  });
});

/**
 * The wiring, read from the source (these are components; their logic is the
 * functions above and the store's, which have tests of their own).
 */
describe('where the words and the block are used', () => {
  const settings = read('components', 'SettingsPanel.tsx');
  const invitations = read('components', 'SharedNotebooks.tsx');

  it('Settings shows the section always, with its description, a labelled field and the button', () => {
    expect(settings).toContain('<h3>{BLOCKED_PEOPLE.title}</h3>');
    expect(settings).toContain('<p class="hint-text">{BLOCKED_PEOPLE.description}</p>');
    expect(settings).toContain('<label for="block-address">{BLOCKED_PEOPLE.fieldLabel}</label>');
    expect(settings).toContain('id="block-address"');
    expect(settings).toContain('{BLOCKED_PEOPLE.block}');
    // Not inside "only when somebody is blocked".
    expect(settings).not.toContain('<h3>Blocked senders</h3>');
    const section = settings.slice(settings.indexOf('<h3>{BLOCKED_PEOPLE.title}</h3>'));
    expect(section.indexOf('id="block-address"')).toBeLessThan(section.indexOf('<Show when={blocks().length > 0}'));
    // "You haven't blocked anyone" only once the list has been READ; one that could not be
    // read says so, in the words a block that did not go through uses.
    expect(settings).toContain("<Match when={blockedListView(blocks().length, blocksRead()) === 'nobody'}>\n                <p class=\"hint-text\">{BLOCKED_PEOPLE.empty}</p>");
    expect(settings).toContain("<Match when={blockedListView(blocks().length, blocksRead()) === 'unread'}>\n                <p class=\"hint-text\" role=\"alert\">That didn't go through. Check your connection and try again.</p>");
    expect(settings.match(/\{BLOCKED_PEOPLE\.empty\}/g)).toHaveLength(1);
    // The load keeps the two apart, and a block the server took is on the list whatever the read-back says.
    expect(settings).toContain("const listed = await sharesInboxStore.listBlocks();\n    if (listed) setBlocks((prev) => listAsKnown(listed, prev, settled));\n    setBlocksRead(listed ? 'read' : 'unread');");
    // A block or an unblock the server took is recorded BEFORE anything is read, shown at once, and
    // then every read goes through what was taken.
    expect(settings).toContain(
      "    settled.set(address.toLowerCase(), { blocked, address, at: new Date().toISOString() });\n"
      + "    setBlocks((prev) => listAsKnown(null, prev, settled));\n"
      + "    const listed = await sharesInboxStore.listBlocks();\n"
      + "    setBlocks((prev) => listAsKnown(listed, prev, settled));\n"
      + "    setBlocksRead((before) => readAfterAction(before, listed !== null));");
    expect(settings).toContain('if (await sharesInboxStore.unblockSender(email)) await showTaken(email, false);');
    expect(settings).toContain('await showTaken(address, true);');
    // Nothing sets the list any other way.
    expect(settings.match(/setBlocks\(/g)).toHaveLength(3);
  });

  it('the button sends only an address that is one and is not blocked yet', () => {
    expect(settings).toContain('const addressReady = () => addressToBlock(blockAddress(), blocks());');
    expect(settings).toContain('disabled={!addressReady() || blocking()}');
    // With that person's invitations not answered here, which the block declines.
    expect(settings).toContain('if (await sharesInboxStore.blockSender(address, undefined, notesStore.unansweredNotebooksFrom(address))) {');
  });

  it('every block names the sender\'s unanswered notebooks: none is made without them', () => {
    const notesView = readFileSync(join(__dirname, '..', 'pages', 'NotesView.tsx'), 'utf8');
    expect(notesView).toContain('await sharesInboxStore.blockSender(email, undefined, notesStore.unansweredNotebooksFrom(email));');
    for (const source of [settings, invitations, notesView]) {
      const calls = source.match(/sharesInboxStore\.blockSender\([^\n]*/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toContain('notesStore.unansweredNotebooksFrom(');
    }
  });

  it('a block that did not go through says so, in the words used elsewhere, and keeps what was typed', () => {
    expect(settings).toContain('<p class="hint-text" role="alert">That didn\'t go through. Check your connection and try again.</p>');
    const blockTyped = settings.slice(settings.indexOf('const blockTyped = async'), settings.indexOf('const formatMb'));
    expect(blockTyped.indexOf("setBlockAddress('');")).toBeGreaterThan(blockTyped.indexOf('if (await sharesInboxStore.blockSender(address, undefined, notesStore.unansweredNotebooksFrom(address))) {'));
    expect(blockTyped.indexOf("setBlockAddress('');")).toBeLessThan(blockTyped.indexOf('} else {'));
  });

  it('each row can be unblocked, and says whom to someone who cannot see the row', () => {
    expect(settings).toContain('aria-label={`${BLOCKED_PEOPLE.unblock} ${b.blocked_email}`}');
    expect(settings).toContain('onClick={() => unblock(b.blocked_email)}');
    expect(settings).toContain('<For each={inListOrder(blocks())}>');
  });

  it('an invitation offers Block beside Accept and Decline, when it says who sent it', () => {
    expect(invitations).toContain('<Show when={invite.sharerEmail}>');
    expect(invitations).toContain('onClick={() => void block(invite)}');
    expect(invitations).toContain('aria-label={`${BLOCKED_PEOPLE.block} ${invite.sharerEmail}`}');
    // A block pressed on an invitation DECLINES the notebook with it, in one request. The steps
    // and their order are lib/declineInvitation `blockFromInvitation`, tested there; here, that
    // the page asks first and then goes through it, with the stores' own calls.
    const block = invitations.slice(invitations.indexOf('const block = async (invite: NotebookInvite)'), invitations.indexOf('const decline = async (invite: NotebookInvite)'));
    expect(block.indexOf('await blockFromInvitation(declined(invite), notesOf(invite.notebookId), email, {')).toBeGreaterThan(block.indexOf('await confirmAction({'));
    expect(block).toContain('...declineSteps(),');
    expect(block).toContain('block: (address, declining) => sharesInboxStore.blockSender(address, declining, notesStore.unansweredNotebooksFrom(address)),');
    expect(block).toContain('theirNotes: () => sharesInboxStore.sharedNotes().filter(s => isFrom(s.sharerEmail, email)).map(s => s.itemId),');
    // The block by itself is a step of that sequence only: made once more when the answer was
    // lost and the list no longer offers the notebook (tested there).
    expect(block).toContain('blockOnly: (address) => sharesInboxStore.blockSender(address, undefined, notesStore.unansweredNotebooksFrom(address)),');
    // Nothing of the page blocks from an invitation without the decline, outside those two steps.
    expect(invitations).not.toContain('sharesInboxStore.blockSender(email)');
    expect(invitations.match(/blockSender\(/g)).toHaveLength(2);
  });
});

describe('the address to block', () => {
  const NONE: { blocked_email: string }[] = [];

  it('is what was typed, without the spaces around it', () => {
    expect(addressToBlock('  sam@example.test \n', NONE)).toBe('sam@example.test');
    expect(addressToBlock('Sam.O+notes@Example.co.uk', NONE)).toBe('Sam.O+notes@Example.co.uk');
  });

  it('is nothing for what is no address', () => {
    for (const typed of ['', '   ', 'sam', 'sam@', '@example.test', 'sam@example', 'sam example@x.test', 'sam@exa mple.test', 'a@b@c.test']) {
      expect(addressToBlock(typed, NONE), JSON.stringify(typed)).toBeNull();
    }
  });

  it('is nothing for an address that is already blocked, whatever its case', () => {
    const blocked = [{ blocked_email: 'Sam@Example.test' }];
    expect(addressToBlock('sam@example.test', blocked)).toBeNull();
    expect(addressToBlock(' SAM@EXAMPLE.TEST ', blocked)).toBeNull();
    expect(addressToBlock('pat@example.test', blocked)).toBe('pat@example.test');
  });
});

describe('the list', () => {
  it('is shown by address, whatever its case, and the list it was given is left as it was', () => {
    // Capitals sort before every small letter as plain text: "Mia" and "Zoe"
    // would both come before "adam" if case counted.
    const given = [{ blocked_email: 'Zoe@x.test' }, { blocked_email: 'adam@x.test' }, { blocked_email: 'Mia@x.test' }, { blocked_email: 'bea@x.test' }];
    expect(inListOrder(given).map(b => b.blocked_email)).toEqual(['adam@x.test', 'bea@x.test', 'Mia@x.test', 'Zoe@x.test']);
    expect(given.map(b => b.blocked_email)).toEqual(['Zoe@x.test', 'adam@x.test', 'Mia@x.test', 'bea@x.test']);
  });
});

describe('whose share it is', () => {
  it('compares addresses whatever their case, and a share with no address is nobody\'s', () => {
    expect(isFrom('Sam@Example.test', 'sam@example.test')).toBe(true);
    expect(isFrom('pat@example.test', 'sam@example.test')).toBe(false);
    expect(isFrom(null, 'sam@example.test')).toBe(false);
    expect(isFrom(undefined, 'sam@example.test')).toBe(false);
  });
});

/**
 * "You haven't blocked anyone." is not shown for a list that could not be
 * read, and a new block's row stays even when the read-back (from a replica)
 * holds older blocks and not yet the new one.
 */
describe('what stands under the field', () => {
  it('the people, whenever there are any', () => {
    for (const read of ['loading', 'read', 'unread'] as const) expect(blockedListView(1, read)).toBe('people');
  });
  it('"nobody" only once the list has been read', () => {
    expect(blockedListView(0, 'read')).toBe('nobody');
  });
  it('a list that could not be read says so, and is never "nobody"', () => {
    expect(blockedListView(0, 'unread')).toBe('unread');
  });
  it('nothing while it is still being read', () => {
    expect(blockedListView(0, 'loading')).toBe('nothing');
  });
});

describe('the list as it is known: what was read, put right by what the server took on this page', () => {
  const AT = '2026-10-07T12:00:00.000Z';
  const older = [{ blocked_email: 'older@example.test', created_at: '2026-10-01T00:00:00Z' }];
  const took = (...entries: [string, boolean][]) =>
    new Map<string, Settled>(entries.map(([address, blocked]) => [address.toLowerCase(), { blocked, address, at: AT }]));
  const NEW = took(['new@example.test', true]);

  it('is the list read back, when it carries the new address (in any case)', () => {
    const listed = [...older, { blocked_email: 'New@Example.test', created_at: '2026-10-07T11:59:59Z' }];
    expect(listAsKnown(listed, [], NEW)).toEqual(listed);
  });
  it('gains the new address when the list read back is a moment behind and holds only older blocks', () => {
    expect(listAsKnown(older, older, NEW)).toEqual([...older, { blocked_email: 'new@example.test', created_at: AT }]);
  });
  it('gains it when the list read back is empty', () => {
    expect(listAsKnown([], [], NEW)).toEqual([{ blocked_email: 'new@example.test', created_at: AT }]);
  });
  it('is what was on screen plus the new address when the list could not be read', () => {
    expect(listAsKnown(null, older, NEW)).toEqual([...older, { blocked_email: 'new@example.test', created_at: AT }]);
  });
  it('never shows an address twice', () => {
    expect(listAsKnown(null, older, took(['OLDER@example.test', true]))).toEqual(older);
  });
  it('the read-back replaces what was on screen: someone unblocked elsewhere is gone', () => {
    const listed = [{ blocked_email: 'new@example.test', created_at: AT }];
    expect(listAsKnown(listed, older, NEW)).toEqual(listed);
  });
  it('with nothing taken on this page, the list read is the list', () => {
    expect(listAsKnown(older, [], new Map())).toEqual(older);
    expect(listAsKnown(null, older, new Map())).toEqual(older);
    expect(listAsKnown([], older, new Map())).toEqual([]);
  });

  /** A second block's read must not drop the first again. */
  it('keeps EVERY address blocked on this page, not only the last', () => {
    const two = took(['first@example.test', true], ['second@example.test', true]);
    // The read after the second block holds neither yet.
    expect(listAsKnown(older, older, two).map(b => b.blocked_email)).toEqual(['older@example.test', 'first@example.test', 'second@example.test']);
    // And one that holds only the second.
    const behind = [...older, { blocked_email: 'second@example.test', created_at: AT }];
    expect(listAsKnown(behind, [], two).map(b => b.blocked_email)).toEqual(['older@example.test', 'second@example.test', 'first@example.test']);
  });

  /** And an unblock's row must not come back with a later read that is a moment
   * behind.
   */
  it('an address unblocked on this page stays off, whatever a read says', () => {
    const gone = took(['Older@Example.test', false]);
    expect(listAsKnown(older, older, gone)).toEqual([]);
    expect(listAsKnown(null, older, gone)).toEqual([]);
    const others = [...older, { blocked_email: 'kept@example.test', created_at: AT }];
    expect(listAsKnown(others, [], gone)).toEqual([{ blocked_email: 'kept@example.test', created_at: AT }]);
  });

  it('the last thing the server took for an address is what counts', () => {
    // Blocked, then unblocked: off. Unblocked, then blocked again: on.
    expect(listAsKnown(older, older, took(['x@example.test', true], ['x@example.test', false]))).toEqual(older);
    expect(listAsKnown([], [], took(['x@example.test', false], ['x@example.test', true]))).toEqual([{ blocked_email: 'x@example.test', created_at: AT }]);
  });
});

/**
 * The list could not be read when the page opened; an address is blocked
 * and unblocked again, both taken by the server. Under the field there
 * must be no "That didn't go through. Check your connection and try
 * again."
 */
describe('what is known of the list after a block or an unblock the server took', () => {
  it('read just now: read', () => {
    for (const before of ['loading', 'read', 'unread'] as const) expect(readAfterAction(before, true)).toBe('read');
  });
  it('not read now, but read before on this page: still read', () => {
    expect(readAfterAction('read', false)).toBe('read');
  });
  it('never read: nothing is said about it, and above all not that something failed', () => {
    expect(readAfterAction('unread', false)).toBe('loading');
    expect(readAfterAction('loading', false)).toBe('loading');
    expect(blockedListView(0, readAfterAction('unread', false))).toBe('nothing');
  });
});

