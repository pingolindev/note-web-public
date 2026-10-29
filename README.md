# Pingolin Note — web editor

This is the web client of Pingolin Note: the editor that runs at
note.pingolin.com, that Pingolin Note for Android ships inside its APK, and
that Pingolin Note for iOS loads.

## Build

The build needs Node 22 and the generated design tokens in `theme/generated/`,
which the stylesheet imports by relative path. Either use the Dockerfile, which
pins Node by digest (the built files are in `/app/dist` of the image):

```bash
docker build -t note-web-build .
```

or build directly:

```bash
cd ui
npm ci
npm run build      # output in ui/dist
```

## Contributing and security

This repository is published as one snapshot per release: each commit is a
shipped version, tagged with it, and the tree at a tag is the source that
version was built from. Development happens elsewhere, so this repository
takes no pull requests or issues.

Report security problems by email to **security@mail.pingolin.com**, not in
public.

## Licence

The Pingolin Note web editor is free software: you can redistribute it and/or
modify it under the terms of the GNU General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your option)
any later version. See [LICENSE](LICENSE).

The Pingolin name and logos are trademarks of Pingolin LLC and are not covered
by the licence. A modified version you distribute must not use them.

The licences of the third-party components the editor bundles are separate;
they are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
