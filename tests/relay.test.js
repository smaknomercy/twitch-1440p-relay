import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import relay from "../relay/worker.js";

const KEY = "test-key-1234567890";
const ENV = { RELAY_KEY: KEY };
const BASE = `https://relay.example.workers.dev/?key=${KEY}`;
const USHER = "https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8";

let calls;

function mockTwitch({ maxRes = "QUAD_HD", reasons = {} } = {}) {
    calls = [];
    globalThis.fetch = async (url, opts = {}) => {
        url = String(url);
        calls.push({ url, opts });
        if (url.startsWith("https://gql.twitch.tv/")) {
            const value = JSON.stringify({ maximum_resolution: maxRes, maximum_resolution_reasons: reasons });
            return new Response(
                JSON.stringify({
                    data: {
                        streamPlaybackAccessToken: { value, signature: "NEWSIG" },
                        videoPlaybackAccessToken: { value, signature: "VODSIG" },
                    },
                })
            );
        }
        if (url.startsWith("https://ipinfo.io/")) {
            return new Response(JSON.stringify({ country: "US", city: "Ashburn", org: "Cloudflare" }));
        }
        return new Response(PLAYLIST, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    };
}

const PLAYLIST = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=2560x1440,CODECS="hev1.1.6.L150.90.0.0.0.0"',
    "https://video-weaver.example/1440.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002A"',
    "https://video-weaver.example/1080.m3u8",
].join("\n");

function post(body, url = BASE) {
    return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => mockTwitch());

test("rejects requests without a key", async () => {
    const r = await relay.fetch(post({ type: "usher", url: USHER }, "https://relay.example.workers.dev/"), ENV);
    assert.equal(r.status, 403);
    assert.equal(calls.length, 0);
});

test("rejects a wrong key", async () => {
    const r = await relay.fetch(post({ type: "usher", url: USHER }, "https://relay.example.workers.dev/?key=nope"), ENV);
    assert.equal(r.status, 403);
});

test("fails closed when RELAY_KEY is missing, short or a placeholder", async () => {
    for (const env of [{}, { RELAY_KEY: "short" }, { RELAY_KEY: "paste-a-random-key-here" }]) {
        const key = env.RELAY_KEY || "";
        const r = await relay.fetch(post({ type: "usher", url: USHER }, `https://relay.example.workers.dev/?key=${key}`), env);
        assert.equal(r.status, 503, JSON.stringify(env));
    }
    assert.equal(calls.length, 0);
});

test("rejects non-usher hosts, including substring tricks", async () => {
    for (const url of [
        "https://example.com/?usher.ttvnw.net/channel/hls/x.m3u8",
        "https://usher.ttvnw.net.example.com/api/channel/hls/x.m3u8",
        "http://usher.ttvnw.net/api/channel/hls/x.m3u8",
        "not a url",
    ]) {
        const r = await relay.fetch(post({ type: "usher", url }), ENV);
        assert.equal(r.status, 400, url);
    }
    assert.equal(calls.length, 0);
});

test("rejects unknown request types", async () => {
    const r = await relay.fetch(post({ type: "gql", body: "PlaybackAccessToken" }), ENV);
    assert.equal(r.status, 400);
});

test("live: fetches a new token and swaps token + sig", async () => {
    const original = `${USHER}?sig=OLD&token=${encodeURIComponent(JSON.stringify({ device_id: "DEV1" }))}&allow_source=true`;
    const r = await relay.fetch(post({ type: "usher", url: original, auth: "OAuth abcdefghijklmnopqrstuvwxyz0123" }), ENV);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("X-TW2K-MaxRes"), "QUAD_HD");

    const gql = calls.find((c) => c.url.startsWith("https://gql.twitch.tv/"));
    const vars = JSON.parse(gql.opts.body).variables;
    assert.equal(vars.login, "somechannel");
    assert.equal(vars.isLive, true);
    assert.equal(gql.opts.headers["Device-ID"], "DEV1");
    assert.equal(gql.opts.headers["Authorization"], "OAuth abcdefghijklmnopqrstuvwxyz0123");

    const usher = new URL(calls.at(-1).url);
    assert.equal(usher.searchParams.get("sig"), "NEWSIG");
    assert.equal(usher.searchParams.get("allow_source"), "true");
});

test("vod: uses videoPlaybackAccessToken", async () => {
    const r = await relay.fetch(post({ type: "usher", url: "https://usher.ttvnw.net/vod/v2/123456789.m3u8?sig=OLD" }), ENV);
    assert.equal(r.status, 200);
    const vars = JSON.parse(calls[0].opts.body).variables;
    assert.equal(vars.isVod, true);
    assert.equal(vars.vodID, "123456789");
    assert.equal(new URL(calls.at(-1).url).searchParams.get("sig"), "VODSIG");
});

test("does not forward malformed auth headers", async () => {
    const r = await relay.fetch(post({ type: "usher", url: USHER, auth: "OAuth x\r\nEvil: 1" }), ENV);
    assert.equal(r.status, 200);
    assert.equal(calls[0].opts.headers["Authorization"], undefined);
});

test("status endpoint reports egress and token check", async () => {
    mockTwitch({ maxRes: "FULL_HD", reasons: { QUAD_HD: ["AUTHZ_NOT_LOGGED_IN"] } });
    const r = await relay.fetch(new Request(`${BASE}&channel=somechannel`), ENV);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.egress.country, "US");
    assert.equal(j.token_check.maximum_resolution, "FULL_HD");
});

test("check endpoint uses the viewer's auth and reports login", async () => {
    mockTwitch({ maxRes: "QUAD_HD" });
    // make the mocked token look logged in
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        if (String(url).startsWith("https://gql.twitch.tv/")) {
            calls.push({ url: String(url), opts });
            const value = JSON.stringify({ maximum_resolution: "QUAD_HD", user_id: 42 });
            return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value, signature: "S" } } }));
        }
        return realFetch(url, opts);
    };
    const r = await relay.fetch(post({ type: "check", channel: "somechannel", auth: "OAuth abcdefghijklmnopqrstuvwxyz0123" }), ENV);
    const j = await r.json();
    assert.equal(j.token_check.maximum_resolution, "QUAD_HD");
    assert.equal(j.token_check.logged_in, true);
    const gql = calls.find((c) => c.url.startsWith("https://gql.twitch.tv/"));
    assert.equal(gql.opts.headers["Authorization"], "OAuth abcdefghijklmnopqrstuvwxyz0123");
    assert.equal(JSON.parse(gql.opts.body).variables.login, "somechannel");
});

test("check endpoint falls back to a default channel for bad input", async () => {
    await relay.fetch(post({ type: "check", channel: "../evil" }), ENV);
    const gql = calls.find((c) => c.url.startsWith("https://gql.twitch.tv/"));
    assert.equal(JSON.parse(gql.opts.body).variables.login, "twitch");
});

test("GET diagnostics support VODs", async () => {
    const r = await relay.fetch(new Request(`${BASE}&vod=123456`), ENV);
    const j = await r.json();
    assert.equal(j.token_check.maximum_resolution, "QUAD_HD");
    const vars = JSON.parse(calls.find((c) => c.url.startsWith("https://gql")).opts.body).variables;
    assert.equal(vars.isVod, true);
    assert.equal(vars.vodID, "123456");
});

test("CORS allows twitch.tv and the extension, not other sites", async () => {
    const origins = {
        "https://www.twitch.tv": "https://www.twitch.tv",
        "chrome-extension://abcdef": "chrome-extension://abcdef",
        "https://evil.example": null,
    };
    for (const [origin, expected] of Object.entries(origins)) {
        const r = await relay.fetch(new Request(BASE, { method: "OPTIONS", headers: { Origin: origin } }), ENV);
        assert.equal(r.headers.get("Access-Control-Allow-Origin"), expected, origin);
    }
});

test("check retries with a known channel when the first one fails", async () => {
    calls = [];
    globalThis.fetch = async (url, opts = {}) => {
        url = String(url);
        calls.push({ url, opts });
        if (url.startsWith("https://gql.twitch.tv/")) {
            const login = JSON.parse(opts.body).variables.login;
            if (login !== "twitch") return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: null } }));
            const value = JSON.stringify({ maximum_resolution: "QUAD_HD", user_id: 1 });
            return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value, signature: "S" } } }));
        }
        return new Response(JSON.stringify({ country: "US" }));
    };
    const r = await relay.fetch(post({ type: "check", channel: "directory" }), ENV);
    const j = await r.json();
    assert.equal(j.token_check.maximum_resolution, "QUAD_HD");
});

test("reports the highest resolution in the playlist", async () => {
    const r = await relay.fetch(post({ type: "usher", url: USHER }), ENV);
    assert.equal(r.headers.get("X-TW2K-Height"), "1440");
    assert.equal(await r.text(), PLAYLIST);
});
