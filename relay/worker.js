// ============================================================
// Twitch 2K relay v3 (Cloudflare Worker)
// ============================================================
// The extension sends the usher master-playlist URL here.
// The relay requests a fresh PlaybackAccessToken from Twitch GQL
// (so Twitch geolocates the relay's IP, not the viewer's),
// swaps token + sig in the usher URL, and returns the playlist.
// Video segments still go directly from Twitch to the viewer.
//
// Security:
//   - requires ?key=<RELAY_KEY> (Worker secret)
//   - only https://usher.ttvnw.net URLs are accepted
//   - no viewer credentials are sent or needed
// ============================================================

const TWITCH_GQL = "https://gql.twitch.tv/gql";
const USHER_HOST = "usher.ttvnw.net";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const TOKEN_QUERY =
    "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {" +
    " streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename }" +
    " videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature __typename }" +
    " }";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "https://www.twitch.tv",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-TW2K-MaxRes, X-TW2K-Colo",
};

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

function isAuthorized(request, env) {
    const expected = env.RELAY_KEY;
    if (!expected) return false; // fail closed if the secret is not set
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

async function fetchToken({ login, vodId }, deviceId) {
    const isLive = !!login;
    const headers = { "Content-Type": "text/plain; charset=UTF-8", "Client-ID": CLIENT_ID };
    if (deviceId) headers["Device-ID"] = deviceId;

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

async function getEgressInfo() {
    try {
        const r = await fetch("https://ipinfo.io/json");
        const j = await r.json();
        return { country: j.country, city: j.city, org: j.org };
    } catch (e) {
        return { error: String(e) };
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

        // ---- Status / diagnostics ----
        if (request.method !== "POST") {
            const egress = await getEgressInfo();
            let tokenCheck = null;
            const channel = new URL(request.url).searchParams.get("channel");
            if (channel) {
                try {
                    const t = await fetchToken({ login: channel }, "");
                    const v = JSON.parse(t.value);
                    tokenCheck = {
                        maximum_resolution: v.maximum_resolution,
                        maximum_resolution_reasons: v.maximum_resolution_reasons,
                        user_ip: v.user_ip,
                    };
                } catch (e) {
                    tokenCheck = { error: String(e.message || e) };
                }
            }
            return json({
                status: "running",
                version: 3,
                entry_colo: request.cf?.colo,
                egress,
                token_check: tokenCheck,
            });
        }

        let payload;
        try {
            payload = await request.json();
        } catch {
            return json({ error: "Invalid JSON" }, 400);
        }

        if (payload.type !== "usher") {
            return json({ error: "Unknown type" }, 400);
        }

        const parsed = parseUsherUrl(payload.url);
        if (!parsed || (!parsed.login && !parsed.vodId)) {
            return json({ error: "Invalid usher URL" }, 400);
        }

        try {
            let deviceId = "";
            try {
                deviceId = JSON.parse(parsed.u.searchParams.get("token") || "{}").device_id || "";
            } catch {}

            const t = await fetchToken(parsed, deviceId);
            parsed.u.searchParams.set("token", t.value);
            parsed.u.searchParams.set("sig", t.signature);

            let maxRes = "";
            try {
                maxRes = JSON.parse(t.value).maximum_resolution || "";
            } catch {}

            const resp = await fetch(parsed.u.href, { headers: { "User-Agent": "Mozilla/5.0" } });
            return new Response(await resp.text(), {
                status: resp.status,
                headers: {
                    "Content-Type": resp.headers.get("Content-Type") || "application/vnd.apple.mpegurl",
                    "X-TW2K-MaxRes": maxRes,
                    "X-TW2K-Colo": request.cf?.colo || "",
                    ...CORS_HEADERS,
                },
            });
        } catch (err) {
            return json({ error: String(err.message || err) }, 502);
        }
    },
};
