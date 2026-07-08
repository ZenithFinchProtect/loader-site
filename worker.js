/**
 * API Proxy — Cloudflare Worker
 */

const NFA_ORIGIN = 'https://nfa-api.acode.ing';

// Stock responses are cached so visitors are served cached data and the NFA
// API sees at most about one stock read every two minutes from us.
const STOCK_CACHE_TTL_SECONDS = 120;

// Loader downloads are limited to one per IP every 2 minutes (KV-backed so it
// holds across isolates). The cooldown starts only after a successful EXE
// build, so the activate → create_exe flow for fresh keys and failed attempts
// aren't penalized.
const DOWNLOAD_COOLDOWN_SECONDS = 120;
let _stockCache = { time: 0, body: null };
// Last time we attempted an upstream stock fetch (successful or not), so
// spamming the endpoint can't multiply calls to NFA even while it's erroring.
let _stockLastAttempt = 0;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Stock-Updated, X-Stock-Cache, X-Upstream-Mode',
    'Access-Control-Max-Age': '86400',
  };
}

// Colo-wide cache key for stock (isolate cache is per-isolate only, so bursts
// spread across isolates need a shared layer too).
const STOCK_EDGE_CACHE_URL = 'https://stock-cache.internal/api/v1/stock';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Per-IP rate limit on API paths so they can't be spammed into tripping
    // NFA's rate limit (static assets are exempt).
    if (url.pathname.startsWith('/api/') && env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return new Response(JSON.stringify({ status: 'error', message: 'Too many requests — slow down' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '10', ...corsHeaders() },
          });
        }
      } catch {
        // Rate limiter unavailable — fail open.
      }
    }

    // --- Serve static assets ---
    if (!url.pathname.startsWith('/api/')) {
      // Stock page: served on the `stock.` subdomain root, or via /stock.
      const onStockSubdomain = url.hostname.split('.')[0] === 'stock';
      const wantsStock = url.pathname === '/stock' || url.pathname === '/stock/';
      if ((onStockSubdomain && (url.pathname === '/' || url.pathname === '')) || wantsStock) {
        const stockReq = new Request(new URL('/stock', url.origin), request);
        return env.ASSETS.fetch(stockReq);
      }
      return env.ASSETS.fetch(request);
    }

    // --- CORS preflight ---
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Full pause: no NFA-bound traffic at all. Toggle with
    // `wrangler secret put NFA_PAUSED` ("1" = paused).
    if (env.NFA_PAUSED === '1') {
      return new Response(JSON.stringify({ status: 'error', message: 'Temporarily unavailable: maintenance in progress' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '600', ...corsHeaders() },
      });
    }

    const isStockRequest = request.method === 'GET' && url.pathname === '/api/v1/stock';
    if (isStockRequest) {
      const now = Date.now();
      if (_stockCache.body && now - _stockCache.time < STOCK_CACHE_TTL_SECONDS * 1000) {
        return new Response(_stockCache.body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'hit', 'X-Stock-Updated': String(_stockCache.time), ...corsHeaders() },
        });
      }
      if (now - _stockLastAttempt < STOCK_CACHE_TTL_SECONDS * 1000) {
        if (_stockCache.body) {
          return new Response(_stockCache.body, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'stale', 'X-Stock-Updated': String(_stockCache.time), ...corsHeaders() },
          });
        }
        return new Response(JSON.stringify({ status: 'error', message: 'Stock temporarily unavailable — try again shortly' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(STOCK_CACHE_TTL_SECONDS), ...corsHeaders() },
        });
      }

      // Colo-shared cache layer (covers bursts spread across isolates).
      try {
        const edgeHit = await caches.default.match(STOCK_EDGE_CACHE_URL);
        if (edgeHit) {
          const body = await edgeHit.text();
          if (edgeHit.headers.get('X-Stock-Ok') === '1') {
            const cachedAt = Number(edgeHit.headers.get('X-Stock-Time')) || now;
            _stockCache = { time: cachedAt, body };
            return new Response(body, {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'edge', 'X-Stock-Updated': String(cachedAt), ...corsHeaders() },
            });
          }
          return new Response(JSON.stringify({ status: 'error', message: 'Stock temporarily unavailable — try again shortly' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(STOCK_CACHE_TTL_SECONDS), ...corsHeaders() },
          });
        }
      } catch {
        // Cache API unavailable — fall through to upstream.
      }

      _stockLastAttempt = now;
    }

    // The proxy attaches the secret NFA key, so only the endpoints the loader
    // and stock pages actually use may pass through; anything else would make
    // this an open relay that outsiders can hammer (looking like us spamming
    // the NFA API).
    const ALLOWED_PROXY_PATHS = new Set([
      '/api/v1/stock',
      '/api/v1/activate',
      '/api/v1/create_exe',
      '/api/v1/check_account',
      '/api/v1/key_details',
    ]);
    if (!ALLOWED_PROXY_PATHS.has(url.pathname)) {
      return new Response(JSON.stringify({ status: 'error', message: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const isDownloadRequest = request.method === 'POST' && url.pathname === '/api/v1/create_exe';
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isDownloadRequest && env.DOWNLOAD_COOLDOWN) {
      try {
        const last = Number(await env.DOWNLOAD_COOLDOWN.get(`dl:${clientIp}`)) || 0;
        const elapsed = Date.now() - last;
        if (last && elapsed < DOWNLOAD_COOLDOWN_SECONDS * 1000) {
          const waitSec = Math.ceil((DOWNLOAD_COOLDOWN_SECONDS * 1000 - elapsed) / 1000);
          return new Response(JSON.stringify({ status: 'error', message: `Download cooldown — try again in ${waitSec}s` }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(waitSec), ...corsHeaders() },
          });
        }
      } catch {
        // KV unavailable — fail open.
      }
    }

    // --- Build upstream request ---
    // When the relay is configured (NFA_RELAY_URL + NFA_RELAY_SECRET secrets),
    // NFA calls go through it: NFA blocks Cloudflare egress IPs, so the relay
    // (on Railway) forwards them from an unblocked IP and holds the NFA key.
    // The relay must be fully configured or not at all. If only one of the two
    // secrets is present we fail loudly here instead of silently falling back
    // to the direct NFA path — whose Cloudflare egress IP is blocked, so a
    // half-configured relay looks exactly like a working site that is simply
    // "out of stock". Failing loudly makes the misconfiguration obvious.
    const hasRelayUrl = Boolean(env.NFA_RELAY_URL);
    const hasRelaySecret = Boolean(env.NFA_RELAY_SECRET);
    if (hasRelayUrl !== hasRelaySecret) {
      return new Response(JSON.stringify({
          status: 'error',
          message: 'Server configuration error: relay is half-configured — set BOTH NFA_RELAY_URL and NFA_RELAY_SECRET (or neither)'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'X-Upstream-Mode': 'misconfigured', ...corsHeaders() },
      });
    }

    const useRelay = hasRelayUrl && hasRelaySecret;
    const upstreamMode = useRelay ? 'relay' : 'direct';
    // The relay proxies /api/v1/* verbatim (no extra prefix), authenticates
    // with `Authorization: Bearer <RELAY_TOKEN>`, and injects the NFA key
    // itself. See ZenithFinchProtect/nfa-relay.
    const upstream = useRelay
      ? new URL(url.pathname + url.search, env.NFA_RELAY_URL)
      : new URL(url.pathname + url.search, NFA_ORIGIN);

    if (!useRelay && !env.NFA_API_KEY) {
      return new Response(JSON.stringify({
          status: 'error',
          message: 'Server configuration error: NFA_API_KEY is not set in Cloudflare'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'X-Upstream-Mode': upstreamMode, ...corsHeaders() },
      });
    }

    const headers = new Headers();
    if (useRelay) {
      headers.set('Authorization', `Bearer ${env.NFA_RELAY_SECRET}`);
    } else {
      headers.set('X-API-Key', env.NFA_API_KEY);
    }
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');

    const init = {
      method: request.method,
      headers,
    };

    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
      const body = await request.text();
      if (body) init.body = body;
    }

    try {
      const response = await fetch(upstream.toString(), init);

      if (isStockRequest) {
        const body = await response.text();
        let ok = false;
        try {
          ok = response.ok && JSON.parse(body).status === 'success';
        } catch {
          ok = false;
        }
        try {
          const cachePut = caches.default.put(STOCK_EDGE_CACHE_URL, new Response(body, {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `s-maxage=${STOCK_CACHE_TTL_SECONDS}`,
              'X-Stock-Ok': ok ? '1' : '0',
              'X-Stock-Time': String(Date.now()),
            },
          }));
          if (ctx) ctx.waitUntil(cachePut); else await cachePut;
        } catch {
          // Cache API unavailable — isolate cache still applies.
        }
        if (ok) {
          _stockCache = { time: Date.now(), body };
          return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'miss', 'X-Stock-Updated': String(_stockCache.time), 'X-Upstream-Mode': upstreamMode, ...corsHeaders() },
          });
        }
        if (_stockCache.body) {
          // Upstream errored (e.g. rate limited): keep serving the last good data.
          return new Response(_stockCache.body, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'stale', 'X-Stock-Updated': String(_stockCache.time), 'X-Upstream-Mode': upstreamMode, ...corsHeaders() },
          });
        }
        return new Response(body, {
          status: response.ok ? 200 : response.status,
          headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'error', 'X-Upstream-Mode': upstreamMode, ...corsHeaders() },
        });
      }

      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('Server');
      responseHeaders.delete('X-Powered-By');
      const cors = corsHeaders();
      for (const [k, v] of Object.entries(cors)) {
        responseHeaders.set(k, v);
      }
      responseHeaders.set('X-Upstream-Mode', upstreamMode);

      if (isDownloadRequest && env.DOWNLOAD_COOLDOWN) {
        const body = await response.text();
        let built = false;
        try {
          built = response.ok && Boolean(JSON.parse(body).exe_base64);
        } catch {
          built = false;
        }
        if (built) {
          try {
            const put = env.DOWNLOAD_COOLDOWN.put(`dl:${clientIp}`, String(Date.now()), { expirationTtl: DOWNLOAD_COOLDOWN_SECONDS });
            if (ctx) ctx.waitUntil(put); else await put;
          } catch {
            // KV unavailable — skip recording the cooldown.
          }
        }
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ status: 'error', message: 'Upstream request failed: ' + err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
  },
};
