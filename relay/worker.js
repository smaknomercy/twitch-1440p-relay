// ============================================================
// Twitch 1440p relay (Cloudflare Worker)
// ============================================================
// The extension sends the usher master-playlist URL here.
// The relay requests a fresh PlaybackAccessToken from Twitch GQL
// (so Twitch geolocates the relay's IP, not the viewer's),
// swaps token + sig in the usher URL, and returns the playlist.
// Video segments still go directly from Twitch to the viewer.
//
// Endpoints (all require ?key=<RELAY_KEY>):
//   GET  /?channel=<login> | /?vod=<id>   diagnostics (anonymous token)
//   POST {type:"usher", url, auth?}       master playlist with a new token
//   POST {type:"check", channel?, auth?}  diagnostics with the viewer's login
//
// Security:
//   - requires ?key=<RELAY_KEY> (Worker secret), fails closed if unset
//   - only https://usher.ttvnw.net URLs are accepted
//   - the viewer's Twitch OAuth token (needed for 1440p) is forwarded
//     to Twitch GQL only; it is never logged or stored
// ============================================================

const VERSION = "3.2.0";
const TWITCH_GQL = "https://gql.twitch.tv/gql";
const USHER_HOST = "usher.ttvnw.net";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const AUTH_RE = /^OAuth [a-z0-9]{20,64}$/i;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/i;
const VOD_RE = /^\d{1,15}$/;

const TOKEN_QUERY =
    "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {" +
    " streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename }" +
    " videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature __typename }" +
    " }";

// Twitch pages and the extension popup may call the relay from a browser.
function corsHeaders(request) {
    const origin = request.headers.get("Origin") || "";
    const allowed = origin === "https://www.twitch.tv" || origin.startsWith("chrome-extension://");
    return {
        ...(allowed ? { "Access-Control-Allow-Origin": origin } : {}),
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Expose-Headers": "X-TW2K-MaxRes, X-TW2K-Reasons, X-TW2K-Height, X-TW2K-Colo",
        Vary: "Origin",
    };
}

function json(request, obj, status = 200) {
    return new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
}

const MIN_KEY_LENGTH = 16;

// Missing, short or placeholder keys (e.g. left from .dev.vars.example) disable the relay.
function hasUsableKey(env) {
    const k = env.RELAY_KEY || "";
    return k.length >= MIN_KEY_LENGTH && !/paste|example|change.?me/i.test(k);
}

function isAuthorized(request, env) {
    const expected = env.RELAY_KEY;
    if (!hasUsableKey(env)) return false; // fail closed
    const provided = new URL(request.url).searchParams.get("key") || "";
    if (provided.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
}

function parseUsherUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    if (u.protocol !== "https:" || u.hostname !== USHER_HOST) return null;
    const live = u.pathname.match(/\/channel\/hls\/([^/]+)\.m3u8$/);
    const vod = u.pathname.match(/\/vod\/(?:v2\/)?(\d+)\.m3u8$/);
    return { u, login: live ? decodeURIComponent(live[1]) : null, vodId: vod ? vod[1] : null };
}

async function fetchToken({ login, vodId }, { deviceId = "", auth = "" } = {}) {
    const isLive = !!login;
    const headers = { "Content-Type": "text/plain; charset=UTF-8", "Client-ID": CLIENT_ID };
    if (deviceId) headers["Device-ID"] = deviceId;
    if (auth && AUTH_RE.test(auth)) headers["Authorization"] = auth;

    const resp = await fetch(TWITCH_GQL, {
        method: "POST",
        headers,
        body: JSON.stringify({
            operationName: "PlaybackAccessToken_Template",
            query: TOKEN_QUERY,
            variables: {
                isLive,
                login: login || "",
                isVod: !isLive,
                vodID: vodId || "",
                playerType: "site",
                platform: "web",
            },
        }),
    });
    const data = await resp.json();
    const t = isLive ? data?.data?.streamPlaybackAccessToken : data?.data?.videoPlaybackAccessToken;
    if (!t?.value || !t?.signature) {
        throw new Error("No token in GQL response: " + JSON.stringify(data).slice(0, 300));
    }
    return t;
}

function describeToken(value) {
    try {
        const v = JSON.parse(value);
        return {
            maximum_resolution: v.maximum_resolution || "",
            maximum_resolution_reasons: v.maximum_resolution_reasons || {},
            logged_in: v.user_id != null,
        };
    } catch {
        return { maximum_resolution: "", maximum_resolution_reasons: {}, logged_in: false };
    }
}

async function getEgressInfo() {
    try {
        const r = await fetch("https://ipinfo.io/json");
        const j = await r.json();
        return { country: j.country, city: j.city, org: j.org };
    } catch (e) {
        return { error: String(e) };
    }
}

async function diagnose(request, target, auth) {
    const egress = await getEgressInfo();
    let token_check = null;
    if (target.login || target.vodId) {
        try {
            const t = await fetchToken(target, { auth });
            token_check = describeToken(t.value);
        } catch (e) {
            token_check = { error: String(e.message || e) };
        }
        // The page may not be a channel (e.g. /directory): retry with a known one.
        if (token_check.error && target.login && target.login !== "twitch") {
            try {
                const t = await fetchToken({ login: "twitch" }, { auth });
                token_check = describeToken(t.value);
            } catch {}
        }
    }
    return json(request, {
        status: "running",
        version: VERSION,
        entry_colo: request.cf?.colo,
        egress,
        token_check,
    });
}

// Highest video height listed in an HLS master playlist (0 if none).
function maxPlaylistHeight(m3u8) {
    let max = 0;
    for (const m of m3u8.matchAll(/RESOLUTION=\d+x(\d+)/g)) {
        max = Math.max(max, Number(m[1]));
    }
    return max;
}

async function handleUsher(request, payload) {
    const parsed = parseUsherUrl(payload.url);
    if (!parsed || (!parsed.login && !parsed.vodId)) {
        return json(request, { error: "Invalid usher URL" }, 400);
    }

    let deviceId = "";
    try {
        deviceId = JSON.parse(parsed.u.searchParams.get("token") || "{}").device_id || "";
    } catch {}

    const t = await fetchToken(parsed, { deviceId, auth: payload.auth });
    parsed.u.searchParams.set("token", t.value);
    parsed.u.searchParams.set("sig", t.signature);
    const info = describeToken(t.value);

    const resp = await fetch(parsed.u.href, { headers: { "User-Agent": "Mozilla/5.0" } });
    const playlist = await resp.text();
    return new Response(playlist, {
        status: resp.status,
        headers: {
            "Content-Type": resp.headers.get("Content-Type") || "application/vnd.apple.mpegurl",
            "X-TW2K-MaxRes": info.maximum_resolution,
            "X-TW2K-Reasons": JSON.stringify(info.maximum_resolution_reasons),
            "X-TW2K-Height": String(maxPlaylistHeight(playlist)),
            "X-TW2K-Colo": request.cf?.colo || "",
            ...corsHeaders(request),
        },
    });
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }

        if (!hasUsableKey(env)) {
            return json(
                request,
                { error: `RELAY_KEY is not set or too weak. Set a random key of at least ${MIN_KEY_LENGTH} characters.` },
                503
            );
        }

        if (!isAuthorized(request, env)) {
            return json(request, { error: "Forbidden" }, 403);
        }

        if (request.method === "GET") {
            const params = new URL(request.url).searchParams;
            const channel = params.get("channel") || "";
            const vod = params.get("vod") || "";
            const target = {
                login: LOGIN_RE.test(channel) ? channel : null,
                vodId: !channel && VOD_RE.test(vod) ? vod : null,
            };
            return diagnose(request, target, "");
        }

        if (request.method !== "POST") {
            return json(request, { error: "Method not allowed" }, 405);
        }

        let payload;
        try {
            payload = await request.json();
        } catch {
            return json(request, { error: "Invalid JSON" }, 400);
        }

        try {
            if (payload.type === "usher") {
                return await handleUsher(request, payload);
            }
            if (payload.type === "check") {
                const channel = LOGIN_RE.test(payload.channel || "") ? payload.channel : "twitch";
                return await diagnose(request, { login: channel }, payload.auth);
            }
            return json(request, { error: "Unknown type" }, 400);
        } catch (err) {
            return json(request, { error: String(err.message || err) }, 502);
        }
    },
};
