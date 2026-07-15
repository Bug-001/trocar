# asight

> A transparent, byte-faithful, cross-provider **oscilloscope for what an agent app really sends the LLM** — every step's full context + streamed reply + usage, replayed and dissected. Personal research instrument.

Design authority: [`spec/01-asight-rfc/`](spec/01-asight-rfc/) (entry `00-overview.md`, decisions D1–D23). This README is the operator's quickstart, not the spec.

## What it does

Capture (never modifies the app) → store raw bytes verbatim → normalize to one cross-provider model → DuckDB → a self-built dashboard: **faithful context replay · cache overlay · resource lifecycle**. OBSERVE-only (v1): it never originates requests, never uses the app's token, binds loopback only.

## Install

Node ≥ 20. Zero runtime deps beyond `@duckdb/node-api` (prebuilt per platform).

```sh
npm install                 # fetch @duckdb/node-api + esbuild
npm run build               # bundle the frontend → src/web/dist/

# put `asight` on PATH (npx-style install; on a nix-managed node, symlink into a user bin):
ln -sf "$PWD/bin/asight.mjs" ~/.local/bin/asight     # ~/.local/bin is on PATH
# or, on a normal npm setup:  npm link
```

Distribution (D23): `npx asight` once published; GitHub Release ships a tarball. Cross-platform (D22): macOS + Linux; Windows reserved.

## Use

```sh
asight etl <capture.ndjson> --rebuild          # populate db/asight.duckdb from a capture
asight serve --port 9801 --source <capture.ndjson>   # dashboard at http://127.0.0.1:9801
asight verify                                  # CA present in user trust store, no machine trust?
```

Live byte-exact capture (macOS + Linux):

```sh
asight on            # generate CA + install USER-LEVEL trust (never machine-wide) + steer CC-CLI
#                      → then run a CC-CLI session; its traffic is captured verbatim (D10)
asight off           # revert the steer   (add --remove-ca to also remove the CA)
```

> ⚠ `asight on` sets `~/.claude/settings.json` `HTTPS_PROXY` → the local capture proxy. Only run it with the capture proxy running; `asight off` reverts cleanly (zero residue).

## Fidelity boundaries (invariant 4 — never hidden)

- The **raw NDJSON is the only source of truth**; DuckDB is a rebuildable projection.
- Data ingested from **demo v0 captures** is labeled `v0-converted`: `req_body` was re-serialized (the demo stored parsed JSON, not the original wire bytes), and pre-D15 captures **summarized** tool schemas (`description_chars` instead of the full schema). The dashboard shows a fidelity banner + per-block badges. **Fresh D10 capture** (via `asight on` + a CC-CLI session) is byte-exact and keeps full tool schemas.
- SSE replies are **reconstructions** of the streamed frames; secret headers are `<redacted>`.

## Status

Phase 1 (data spine) · cross-platform onboard (D22) · Phase 2 (query + loopback read-only server) · Phase 3 (vanilla + esbuild dashboard) are implemented and green. Phase 4 (Codex + DeepSeek adapters) is gated on real capture of those harnesses.

```sh
npm test        # full suite
```
