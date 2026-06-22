# loader-site

Unbranded, single-page loader download site.

Visitors enter their activation key and download the loader. Re-downloads are
free for valid keys. There is no admin panel — this is the download page only.

## How it works

- `public/index.html` — the static download page.
- `functions/api/v1/[[path]].js` — Cloudflare Pages Function that proxies
  `/api/v1/*` requests to the upstream API, injecting the `NFA_API_KEY` secret.
- `worker.js` / `wrangler.toml` — equivalent setup for a Cloudflare Worker
  deployment (serves the static assets and proxies the API).

The page calls `POST /api/v1/create_exe` with the activation key and downloads
the returned executable.

## Configuration

Set the following secret in your Cloudflare project:

- `NFA_API_KEY` — upstream API key.

## Deploy

Cloudflare Pages: connect this repo, set the build output directory to `public`,
and add the `NFA_API_KEY` secret.

Cloudflare Workers: `wrangler deploy` (set the secret with
`wrangler secret put NFA_API_KEY`).
