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
 * Loads the canonical provider list from `provider-specs.json` — the
 * file is emitted by the mobile SDK's `dump-import-providers` binary and
 * is byte-identical to the copy the Note Android app ships as
 * `import_providers.json`.
 *
 * Never edit `provider-specs.json` by hand: change the provider list in
 * the mobile SDK's Rust source and regenerate the file.
 *
 * The `AuthMethod.o_auth2_pkce` + `AuthMethod.credentials` shapes stay
 * defined here so the schema covers them; no provider uses them.
 */

import providerSpecsRaw from './provider-specs.json';
import type { ImportSource } from './types';

export type ImportSectionId = 'file' | 'connect';

export type AuthMethod =
  | { kind: 'file_upload'; mime_types: string[] }
  | { kind: 'takeout_link'; external_url: string; mime_types: string[] }
  | {
      kind: 'o_auth2_pkce';
      authorization_url: string;
      token_url: string;
      scopes: string[];
      client_id_env_key: string;
      redirect_path: string;
    }
  | {
      kind: 'credentials';
      fields: Array<{ key: string; label: string; placeholder: string; secret: boolean }>;
    };

export interface ProviderSpec {
  id: string;
  display_name: string;
  section: ImportSectionId;
  auth_method: AuthMethod;
  icon_name: string;
  brand_color: string;
  instructions_markdown: string;
  caveats: string[];
}

export const providerSpecs: ProviderSpec[] = providerSpecsRaw as ProviderSpec[];

export function byId(id: string): ProviderSpec | undefined {
  return providerSpecs.find((p) => p.id === id);
}

export function bySection(section: ImportSectionId): ProviderSpec[] {
  return providerSpecs.filter((p) => p.section === section);
}

/**
 * Maps a shared provider spec id to the internal `ImportSource`
 * discriminator used by the parser/importer pipeline. Mirrors the
 * Android app's `sourceForSpec` (ImportViewModel).
 */
export function sourceForSpec(spec: ProviderSpec): ImportSource | null {
  switch (spec.id) {
    case 'google_keep':         return 'GOOGLE_KEEP';
    case 'evernote_file':       return 'EVERNOTE';
    case 'standard_notes_file': return 'STANDARD_NOTES';
    case 'plain_text':          return 'PLAIN_TEXT';
    default:                    return null;
  }
}
