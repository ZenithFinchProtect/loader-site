# loader-site

Unbranded, single-page loader download site.

Visitors enter their activation key and download the loader. Re-downloads are
free for valid keys. There is no admin panel — this is the download page only.

## How it works

- `public/index.html` — the static download page.
- `public/stock.html` — live account-stock page (see "Stock page" below).
- `functions/api/v1/[[path]].js` — Cloudflare Pages Function that proxies
  `/api/v1/*` requests to the upstream API, injecting the `NFA_API_KEY` secret.
- `worker.js` / `wrangler.toml` — equivalent setup for a Cloudflare Worker
  deployment (serves the static assets and proxies the API).

The page calls `POST /api/v1/create_exe` with the activation key and downloads
the returned executable.

## Stock page

`public/stock.html` shows live availability for the accounts sold on the store,
grouped by product (Rust, CS2, DayZ, ARC, EFT, BF6). It fetches the same-origin
proxy endpoint `GET /api/v1/stock` (forwarded upstream with the `NFA_API_KEY`)
and renders one card per type with a green "In Stock · N" / red "Out of Stock"
indicator, auto-refreshing every 60s.

It is served on the **`stock.` subdomain root** (e.g. `stock.example.com`) and
also at the `/stock` path on the main domain. Only stock keys whose prefix is
listed in the page's `data-products` attribute are shown, so internal/unsold
types never appear. To change which products show (or their labels), edit the
`data-products` attribute in `public/stock.html`.

### Routing the subdomain

- **Cloudflare Workers:** add a custom domain / route for `stock.<domain>` to
  this Worker. `worker.js` detects the `stock.` host and serves `stock.html`.
- **Cloudflare Pages:** add `stock.<domain>` as a custom domain on the project
  and serve the same site (or just link to `/stock`).

## Configuration

Set the following secret in your Cloudflare project:

- `NFA_API_KEY` — upstream API key.

## Deploy

Cloudflare Pages: connect this repo, set the build output directory to `public`,
and add the `NFA_API_KEY` secret.

Cloudflare Workers: `wrangler deploy` (set the secret with
`wrangler secret put NFA_API_KEY`).
