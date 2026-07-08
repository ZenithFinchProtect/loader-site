/**
 * API Proxy — Cloudflare Worker
 */

const NFA_ORIGIN = 'https://nfa-api.acode.ing';

// Stock responses are cached so visitors are served cached data and the NFA
// API sees at most about one stock read every two minutes from us.
const STOCK_CACHE_TTL_SECONDS = 120;
let _stockCache = { time: 0, body: null };
// Last time we attempted an upstream stock fetch (successful or not), so
// spamming the endpoint can't multiply calls to NFA even while it's erroring.
let _stockLastAttempt = 0;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Stock-Updated, X-Stock-Cache',
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

    // --- Build upstream request ---
    // When the relay is configured (NFA_RELAY_URL + NFA_RELAY_SECRET secrets),
    // NFA calls go through it: NFA blocks Cloudflare egress IPs, so the relay
    // (on Railway) forwards them from an unblocked IP and holds the NFA key.
    const useRelay = env.NFA_RELAY_URL && env.NFA_RELAY_SECRET;
    const upstream = useRelay
      ? new URL(`/relay${url.pathname}${url.search}`, env.NFA_RELAY_URL)
      : new URL(url.pathname + url.search, NFA_ORIGIN);

    if (!useRelay && !env.NFA_API_KEY) {
      return new Response(JSON.stringify({
          status: 'error',
          message: 'Server configuration error: NFA_API_KEY is not set in Cloudflare'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const headers = new Headers();
    if (useRelay) {
      headers.set('X-Relay-Secret', env.NFA_RELAY_SECRET);
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
            headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'miss', 'X-Stock-Updated': String(_stockCache.time), ...corsHeaders() },
          });
        }
        if (_stockCache.body) {
          // Upstream errored (e.g. rate limited): keep serving the last good data.
          return new Response(_stockCache.body, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'stale', 'X-Stock-Updated': String(_stockCache.time), ...corsHeaders() },
          });
        }
        return new Response(body, {
          status: response.ok ? 200 : response.status,
          headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'error', ...corsHeaders() },
        });
      }

      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('Server');
      responseHeaders.delete('X-Powered-By');
      const cors = corsHeaders();
      for (const [k, v] of Object.entries(cors)) {
        responseHeaders.set(k, v);
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
