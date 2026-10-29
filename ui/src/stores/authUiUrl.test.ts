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

/**
 * The account-portal origin must follow the environment note-ui is served from.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 *   One bundle is served in every environment, and nothing in the image build
 *   sets VITE_AUTH_UI_URL, so the origin has to come from the page's own host.
 *   A mapping that is wrong only in production cannot be seen in a development
 *   stack, where the wrong answer and the right answer can be the same string;
 *   in production it would bounce users to the wrong environment's portal on
 *   login, logout, billing and cross-origin key federation. So the production
 *   row below is the whole point: assert the mapping that a development stack
 *   can never exercise.
 */
import { describe, it, expect } from 'vitest';
import { accountOriginForHost } from './auth';

describe('accountOriginForHost', () => {
  it('maps the prod note host to the prod portal', () => {
    expect(accountOriginForHost('note.pingolin.com')).toBe('https://account.pingolin.com');
  });

  it('maps the dev note host to the dev portal', () => {
    expect(accountOriginForHost('note.pingolindev.com')).toBe('https://account.pingolindev.com');
  });

  it('never returns a pingolindev host for a pingolin.com origin', () => {
    // The case that matters: a production bundle never hands
    // out the dev portal.
    expect(accountOriginForHost('note.pingolin.com')).not.toContain('pingolindev');
  });

  it('sends loopback to the hosted dev portal', () => {
    expect(accountOriginForHost('localhost')).toBe('https://account.pingolindev.com');
    expect(accountOriginForHost('127.0.0.1')).toBe('https://account.pingolindev.com');
  });

  it('swaps only the leading label', () => {
    expect(accountOriginForHost('note.staging.pingolin.com'))
      .toBe('https://account.staging.pingolin.com');
  });
});
