# Third-party licences — Pingolin Note web editor

The Pingolin Note web editor is licensed under GPL-3.0-or-later (see
[LICENSE](LICENSE)). This file inventories the third-party packages it depends
on and the licence each arrives under.

It is generated with `license-checker` over the editor's production
dependencies — do not hand-edit it. The generator is allow-list driven: a
package under a licence that is not already listed fails it rather than
quietly adding a new licence to the inventory.

## What this list covers

Attribution obligations attach to what is **redistributed**, so the scope is the
packages whose code ends up in the built editor. **Development dependencies are
excluded** (npm `devDependencies`): they build and run the tests and ship in
nothing.

## Licences needing a human look

Everything else in this inventory is MIT, Apache-2.0, BSD-2/3-Clause, ISC,
0BSD, Unlicense or CC0-1.0 — all permissive. These are not:

| Dependency | Licence | Why it is called out |
| --- | --- | --- |
| `dompurify` | MPL-2.0 OR Apache-2.0 | Dual-licensed; take it under **Apache-2.0** and the MPL-2.0 question does not arise. |
| `jszip` | MIT OR GPL-3.0-or-later | Dual-licensed; take it under **MIT**, the lighter of the two. |
| `pako` | MIT AND Zlib | Conjunctive, not a choice: both sets of terms apply. Both are permissive. |
| `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono` | OFL-1.1 | The SIL Open Font License covers font files, not the software that renders them. It permits bundling and redistribution; its reserved-font-name clause only restricts shipping *modified* fonts under the original name. |

## Packages

### Licence summary

| Licence | Packages |
| --- | --- |
| `MIT` | 81 |
| `ISC` | 7 |
| `OFL-1.1` | 2 |
| `(MIT AND Zlib)` | 1 |
| `(MIT OR GPL-3.0-or-later)` | 1 |
| `(MPL-2.0 OR Apache-2.0)` | 1 |
| `BSD-3-Clause` | 1 |

### Packages

| Package | Licence | Source |
| --- | --- | --- |
| `@codemirror/autocomplete` 6.20.1 | `MIT` | [repo](https://github.com/codemirror/autocomplete) |
| `@codemirror/commands` 6.10.3 | `MIT` | [repo](https://github.com/codemirror/commands) |
| `@codemirror/history` 0.19.2 | `MIT` | [repo](https://github.com/codemirror/history) |
| `@codemirror/lang-angular` 0.1.4 | `MIT` | [repo](https://github.com/codemirror/lang-angular) |
| `@codemirror/lang-cpp` 6.0.3 | `MIT` | [repo](https://github.com/codemirror/lang-cpp) |
| `@codemirror/lang-css` 6.3.1 | `MIT` | [repo](https://github.com/codemirror/lang-css) |
| `@codemirror/lang-go` 6.0.1 | `MIT` | [repo](https://github.com/codemirror/lang-go) |
| `@codemirror/lang-html` 6.4.11 | `MIT` | [repo](https://github.com/codemirror/lang-html) |
| `@codemirror/lang-java` 6.0.2 | `MIT` | [repo](https://github.com/codemirror/lang-java) |
| `@codemirror/lang-javascript` 6.2.5 | `MIT` | [repo](https://github.com/codemirror/lang-javascript) |
| `@codemirror/lang-jinja` 6.0.0 | `MIT` | [repo](https://github.com/codemirror/lang-jinja) |
| `@codemirror/lang-json` 6.0.2 | `MIT` | [repo](https://github.com/codemirror/lang-json) |
| `@codemirror/lang-less` 6.0.2 | `MIT` | [repo](https://github.com/codemirror/lang-less) |
| `@codemirror/lang-liquid` 6.3.2 | `MIT` | [repo](https://github.com/codemirror/lang-liquid) |
| `@codemirror/lang-markdown` 6.5.0 | `MIT` | [repo](https://github.com/codemirror/lang-markdown) |
| `@codemirror/lang-php` 6.0.2 | `MIT` | [repo](https://github.com/codemirror/lang-php) |
| `@codemirror/lang-python` 6.2.1 | `MIT` | [repo](https://github.com/codemirror/lang-python) |
| `@codemirror/lang-rust` 6.0.2 | `MIT` | [repo](https://github.com/codemirror/lang-rust) |
| `@codemirror/lang-sass` 6.0.2 | `MIT` | [repo](https://github.com/codemirror/lang-sass) |
| `@codemirror/lang-sql` 6.10.0 | `MIT` | [repo](https://github.com/codemirror/lang-sql) |
| `@codemirror/lang-vue` 0.1.3 | `MIT` | [repo](https://github.com/codemirror/lang-vue) |
| `@codemirror/lang-wast` 6.0.2 | `MIT` | [repo](https://github.com/codemirror/lang-wast) |
| `@codemirror/lang-xml` 6.1.0 | `MIT` | [repo](https://github.com/codemirror/lang-xml) |
| `@codemirror/lang-yaml` 6.1.3 | `MIT` | [repo](https://github.com/codemirror/lang-yaml) |
| `@codemirror/language-data` 6.5.2 | `MIT` | [repo](https://github.com/codemirror/language-data) |
| `@codemirror/language` 6.12.3 | `MIT` | [repo](https://github.com/codemirror/language) |
| `@codemirror/legacy-modes` 6.5.2 | `MIT` | [repo](https://github.com/codemirror/legacy-modes) |
| `@codemirror/lint` 6.9.5 | `MIT` | [repo](https://github.com/codemirror/lint) |
| `@codemirror/rangeset` 0.19.9 | `MIT` | [repo](https://github.com/codemirror/rangeset) |
| `@codemirror/state` 0.19.9 | `MIT` | [repo](https://github.com/codemirror/state) |
| `@codemirror/state` 6.6.0 | `MIT` | [repo](https://github.com/codemirror/state) |
| `@codemirror/text` 0.19.6 | `MIT` | [repo](https://github.com/codemirror/text) |
| `@codemirror/view` 0.19.48 | `MIT` | [repo](https://github.com/codemirror/view) |
| `@codemirror/view` 6.41.0 | `MIT` | [repo](https://github.com/codemirror/view) |
| `@fontsource/ibm-plex-mono` 5.2.7 | `OFL-1.1` | [repo](https://github.com/fontsource/font-files) |
| `@fontsource/ibm-plex-sans` 5.2.8 | `OFL-1.1` | [repo](https://github.com/fontsource/font-files) |
| `@lezer/common` 1.5.2 | `MIT` | [repo](https://github.com/lezer-parser/common) |
| `@lezer/cpp` 1.1.5 | `MIT` | [repo](https://github.com/lezer-parser/cpp) |
| `@lezer/css` 1.3.3 | `MIT` | [repo](https://github.com/lezer-parser/css) |
| `@lezer/go` 1.0.1 | `MIT` | [repo](https://github.com/lezer-parser/go) |
| `@lezer/highlight` 1.2.3 | `MIT` | [repo](https://github.com/lezer-parser/highlight) |
| `@lezer/html` 1.3.13 | `MIT` | [repo](https://github.com/lezer-parser/html) |
| `@lezer/java` 1.1.3 | `MIT` | [repo](https://github.com/lezer-parser/java) |
| `@lezer/javascript` 1.5.4 | `MIT` | [repo](https://github.com/lezer-parser/javascript) |
| `@lezer/json` 1.0.3 | `MIT` | [repo](https://github.com/lezer-parser/json) |
| `@lezer/lr` 1.4.8 | `MIT` | [repo](https://github.com/lezer-parser/lr) |
| `@lezer/markdown` 1.6.3 | `MIT` | [repo](https://github.com/lezer-parser/markdown) |
| `@lezer/php` 1.0.5 | `MIT` | [repo](https://github.com/lezer-parser/php) |
| `@lezer/python` 1.1.18 | `MIT` | [repo](https://github.com/lezer-parser/python) |
| `@lezer/rust` 1.0.2 | `MIT` | [repo](https://github.com/lezer-parser/rust) |
| `@lezer/sass` 1.1.0 | `MIT` | [repo](https://github.com/lezer-parser/sass) |
| `@lezer/xml` 1.0.6 | `MIT` | [repo](https://github.com/lezer-parser/xml) |
| `@lezer/yaml` 1.0.4 | `MIT` | [repo](https://github.com/lezer-parser/yaml) |
| `@marijn/find-cluster-break` 1.0.2 | `MIT` | [repo](https://github.com/marijnh/find-cluster-break) |
| `@noble/hashes` 1.8.0 | `MIT` | [repo](https://github.com/paulmillr/noble-hashes) |
| `@solidjs/router` 0.15.4 | `MIT` | [repo](https://github.com/solidjs/solid-router) |
| `@types/dompurify` 3.0.5 | `MIT` | [repo](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/libsodium-wrappers` 0.7.14 | `MIT` | [repo](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/trusted-types` 2.0.7 | `MIT` | [repo](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `bcryptjs` 3.0.3 | `BSD-3-Clause` | [repo](https://github.com/dcodeIO/bcrypt.js) |
| `commander` 15.0.0 | `MIT` | [repo](https://github.com/tj/commander.js) |
| `core-util-is` 1.0.3 | `MIT` | [repo](https://github.com/isaacs/core-util-is) |
| `crelt` 1.0.6 | `MIT` | [repo](https://github.com/marijnh/crelt) |
| `csstype` 3.2.3 | `MIT` | [repo](https://github.com/frenic/csstype) |
| `dompurify` 3.4.17 | `(MPL-2.0 OR Apache-2.0)` | [repo](https://github.com/cure53/DOMPurify) |
| `idb` 8.0.3 | `ISC` | [repo](https://github.com/jakearchibald/idb) |
| `immediate` 3.0.6 | `MIT` | [repo](https://github.com/calvinmetcalf/immediate) |
| `inherits` 2.0.4 | `ISC` | [repo](https://github.com/isaacs/inherits) |
| `isarray` 1.0.0 | `MIT` | [repo](https://github.com/juliangruber/isarray) |
| `isomorphic.js` 0.2.5 | `MIT` | [repo](https://github.com/dmonad/isomorphic.js) |
| `jszip` 3.10.1 | `(MIT OR GPL-3.0-or-later)` | [repo](https://github.com/Stuk/jszip) |
| `katex` 0.19.1 | `MIT` | [repo](https://github.com/KaTeX/KaTeX) |
| `lib0` 0.2.117 | `MIT` | [repo](https://github.com/dmonad/lib0) |
| `libsodium-sumo` 0.7.16 | `ISC` | [repo](https://github.com/jedisct1/libsodium.js) |
| `libsodium-sumo` 0.8.4 | `ISC` | [repo](https://github.com/jedisct1/libsodium.js) |
| `libsodium-wrappers-sumo` 0.7.16 | `ISC` | [repo](https://github.com/jedisct1/libsodium.js) |
| `libsodium-wrappers` 0.8.4 | `ISC` | [repo](https://github.com/jedisct1/libsodium.js) |
| `libsodium` 0.8.4 | `ISC` | [repo](https://github.com/jedisct1/libsodium.js) |
| `lie` 3.3.0 | `MIT` | [repo](https://github.com/calvinmetcalf/lie) |
| `pako` 1.0.11 | `(MIT AND Zlib)` | [repo](https://github.com/nodeca/pako) |
| `process-nextick-args` 2.0.1 | `MIT` | [repo](https://github.com/calvinmetcalf/process-nextick-args) |
| `readable-stream` 2.3.8 | `MIT` | [repo](https://github.com/nodejs/readable-stream) |
| `safe-buffer` 5.1.2 | `MIT` | [repo](https://github.com/feross/safe-buffer) |
| `seroval-plugins` 1.6.8 | `MIT` | [repo](https://github.com/lxsmnsyc/seroval) |
| `seroval` 1.6.8 | `MIT` | [repo](https://github.com/lxsmnsyc/seroval) |
| `setimmediate` 1.0.5 | `MIT` | [repo](https://github.com/YuzuJS/setImmediate) |
| `solid-js` 1.9.12 | `MIT` | [repo](https://github.com/solidjs/solid) |
| `string_decoder` 1.1.1 | `MIT` | [repo](https://github.com/nodejs/string_decoder) |
| `style-mod` 4.1.3 | `MIT` | [repo](https://github.com/marijnh/style-mod) |
| `util-deprecate` 1.0.2 | `MIT` | [repo](https://github.com/TooTallNate/util-deprecate) |
| `w3c-keyname` 2.2.8 | `MIT` | [repo](https://github.com/marijnh/w3c-keyname) |
| `y-codemirror.next` 0.3.5 | `MIT` | [repo](https://github.com/yjs/y-codemirror.next) |
| `y-protocols` 1.0.7 | `MIT` | [repo](https://github.com/yjs/y-protocols) |
| `yjs` 13.6.30 | `MIT` | [repo](https://github.com/yjs/yjs) |
