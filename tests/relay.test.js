import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import relay from "../relay/worker.js";

const KEY = "test-key-123";
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
        return new Response("#EXTM3U\n", { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    };
}

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

test("fails closed when RELAY_KEY is not set", async () => {
    const r = await relay.fetch(post({ type: "usher", url: USHER }), {});
    assert.equal(r.status, 403);
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
