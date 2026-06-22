/**
 * API Proxy — Cloudflare Pages Function
 *
 * Catches all requests to /api/v1/* and forwards them to the upstream
 * API with the secret API key injected.
 *
 * Secrets (set via Cloudflare dashboard or wrangler):
 *   NFA_API_KEY — upstream API key
 */

const NFA_ORIGIN = 'https://nfa-api.acode.ing';

export async function onRequest(context) {
    const { request, env, params } = context;

    // --- CORS preflight ---
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    const url = new URL(request.url);

    // --- Build the upstream path ---
    // params.path is an array of path segments after /api/v1/
    const subpath = params.path ? params.path.join('/') : '';
    const upstream = `${NFA_ORIGIN}/api/v1/${subpath}${url.search}`;

    // --- Build upstream request ---
    if (!env.NFA_API_KEY) {
        return new Response(JSON.stringify({ status: 'error', message: 'Server configuration error: NFA_API_KEY is not set in Cloudflare' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    const headers = new Headers();
    headers.set('X-API-Key', env.NFA_API_KEY);
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');

    const init = { method: request.method, headers };

    // Forward body for POST/PUT/DELETE
    if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
        const body = await request.text();
        if (body) init.body = body;
    }

    try {
        const response = await fetch(upstream, init);

        // Build response with clean headers
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete('Server');
        responseHeaders.delete('X-Powered-By');
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
        });
    } catch (err) {
        return new Response(
            JSON.stringify({ status: 'error', message: 'Upstream request failed: ' + err.message }),
            {
                status: 502,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            }
        );
    }
}
