FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder

WORKDIR /app

COPY ui/package.json ui/package-lock.json ./

# `npm ci` and nothing else, with no `|| npm install` fallback: `npm ci` fails
# precisely when package.json and the lockfile disagree, and `npm install` would
# answer that by re-resolving the ranges and installing whatever it likes — so
# the one case the lockfile exists to catch would be the one case it is
# bypassed, silently, in a published image. A lockfile that does not match
# package.json is a failed build. The COPY above names the lockfile without a
# `*` for the same reason: a build with no lockfile should stop, not proceed on
# ranges.
RUN npm ci

# See .dockerignore: node_modules MUST stay excluded from this context, or
# this line merges the build host's installed tree over the one npm ci just
# resolved and the lockfile install is decoration.
COPY ui/ .

# Shared design tokens live at <repo>/theme/generated/ and are imported as
# `../../theme/generated/` from ui/src/index.css. Copy them to /theme/ so
# the relative path resolves from /app/src/.
COPY theme/generated/ /theme/generated/

# The image build passes these build args. ARG is per-stage, so they are
# declared in this stage, and that is what lets the BUNDLE carry its own
# identity: Vite bakes any `VITE_*` env var in at build time, so Settings can
# tell a person which build they are looking at. The offline-shell service
# worker keeps serving the bundle it has until every tab on the origin is
# closed, so "a fix is deployed" and "you are running it" can come apart for
# hours with nothing else on screen to say so.
#
# BUILD_VERSION is the number this image is tagged with (e.g. `v0.1.668`) —
# the half a person can compare against a deploy.
# BUILD_TIME is deliberately NOT forwarded to Vite: the version and the commit
# answer "which build", and a timestamp in the row only adds noise.
ARG BUILD_COMMIT=unknown
ARG BUILD_VERSION=unknown
ENV VITE_BUILD_COMMIT=$BUILD_COMMIT
ENV VITE_BUILD_VERSION=$BUILD_VERSION

RUN npm run build
