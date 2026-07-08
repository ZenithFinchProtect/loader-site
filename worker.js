/**
 * API Proxy — Cloudflare Worker
 */

const NFA_ORIGIN = 'https://nfa-api.acode.ing';

// Stock responses are cached briefly so visitors are served cached data and
// the NFA API only sees an occasional request from us.
const STOCK_CACHE_TTL_SECONDS = 5;
let _stockCache = { time: 0, body: null };

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    const isStockRequest = request.method === 'GET' && url.pathname === '/api/v1/stock';
    if (isStockRequest && _stockCache.body && Date.now() - _stockCache.time < STOCK_CACHE_TTL_SECONDS * 1000) {
      return new Response(_stockCache.body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'hit', ...corsHeaders() },
      });
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
    const upstream = new URL(url.pathname + url.search, NFA_ORIGIN);

    if (!env.NFA_API_KEY) {
      return new Response(JSON.stringify({
          status: 'error',
          message: 'Server configuration error: NFA_API_KEY is not set in Cloudflare'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const headers = new Headers();
    headers.set('X-API-Key', env.NFA_API_KEY);
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

      if (isStockRequest && response.ok) {
        const body = await response.text();
        let ok = false;
        try {
          ok = JSON.parse(body).status === 'success';
        } catch {
          ok = false;
        }
        if (ok) {
          _stockCache = { time: Date.now(), body };
        } else if (_stockCache.body) {
          // Upstream errored (e.g. rate limited): keep serving the last good data.
          return new Response(_stockCache.body, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'stale', ...corsHeaders() },
          });
        }
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Stock-Cache': 'miss', ...corsHeaders() },
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
