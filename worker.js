// ============================================================
// Twitch 2K Quality Unlocker — Cloudflare Worker Relay (hardened)
// ============================================================
// Changes vs. upstream:
//   1. Access key: requests must include ?key=<RELAY_KEY> in the URL.
//      RELAY_KEY is stored as a Worker secret (Settings → Variables and Secrets).
//   2. Usher URL is validated by parsed hostname, not substring match
//      (upstream allowed fetching arbitrary URLs → open proxy / SSRF).
//   3. GQL relay only accepts PlaybackAccessToken queries
//      (upstream relayed any GQL query).
//   4. Only https:// usher URLs are accepted.
// The extension itself needs no changes: paste the Worker URL
// with ?key=... into the popup.
// ============================================================

const TWITCH_GQL = "https://gql.twitch.tv/gql";
const USHER_HOST = "usher.ttvnw.net";
const DEFAULT_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "https://www.twitch.tv",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

function isAuthorized(request, env) {
    const expected = env.RELAY_KEY;
    if (!expected) return false; // fail closed if the secret is not set
    const provided = new URL(request.url).searchParams.get("key") || "";
    if (provided.length !== expected.length) return false;
    // Constant-time comparison
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
}

function isValidUsherUrl(raw) {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" && u.hostname === USHER_HOST;
    } catch {
        return false;
    }
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (!isAuthorized(request, env)) {
            return json({ error: "Forbidden" }, 403);
        }

        if (request.method !== "POST") {
            return json({ name: "Twitch 2K relay", status: "running" });
        }

        let payload;
        try {
            payload = await request.json();
        } catch {
            return json({ error: "Invalid JSON" }, 400);
        }

        try {
            // ---- GQL: PlaybackAccessToken only ----
            if (payload.type === "gql") {
                if (typeof payload.body !== "string" || !payload.body.includes("PlaybackAccessToken")) {
                    return json({ error: "Only PlaybackAccessToken is allowed" }, 400);
                }

                const headers = {
                    "Content-Type": "text/plain; charset=UTF-8",
                    "Client-ID": payload.clientId || DEFAULT_CLIENT_ID,
                };
                if (payload.auth && payload.auth !== "undefined") {
                    headers["Authorization"] = payload.auth;
                }
                if (payload.deviceId) {
                    headers["Device-ID"] = payload.deviceId;
                }

                const resp = await fetch(TWITCH_GQL, {
                    method: "POST",
                    headers,
                    body: payload.body,
                });

                return new Response(await resp.text(), {
                    status: resp.status,
                    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
                });
            }

            // ---- Usher: playlist manifest ----
            if (payload.type === "usher") {
                if (!isValidUsherUrl(payload.url)) {
                    return json({ error: "Invalid usher URL" }, 400);
                }

                const resp = await fetch(payload.url, {
                    headers: { "User-Agent": "Mozilla/5.0" },
                });

                return new Response(await resp.text(), {
                    status: resp.status,
                    headers: {
                        "Content-Type": resp.headers.get("Content-Type") || "application/vnd.apple.mpegurl",
                        ...CORS_HEADERS,
                    },
                });
            }

            return json({ error: "Unknown type" }, 400);
        } catch (err) {
            return json({ error: "Upstream request failed" }, 502);
        }
    },
};
