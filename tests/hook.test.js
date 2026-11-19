import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const HOOK_SRC = readFileSync(new URL("../extension/hook.js", import.meta.url), "utf8");
const PROXY = "https://relay.example.workers.dev/?key=k";
const TOKEN = "abcdefghijklmnopqrstuvwxyz0123";

// In-memory BroadcastChannel shared between the fake page and worker scopes.
function makeBus() {
    const members = new Set();
    return class FakeBroadcastChannel {
        constructor(name) {
            this.name = name;
            this.onmessage = null;
            members.add(this);
        }
        postMessage(data) {
            for (const m of members) {
                if (m !== this && m.name === this.name && m.onmessage) {
                    queueMicrotask(() => m.onmessage({ data }));
                }
            }
        }
        close() {
            members.delete(this);
        }
    };
}

// Minimal page environment for hook.js
function loadHook({ proxy = PROXY, cookie = `x=1; auth-token=${TOKEN}`, relayHeaders = {} } = {}) {
    const blobs = new Map();
    const created = [];
    const fetchCalls = [];
    const posted = [];
    const BroadcastChannel = makeBus();

    class FakeWorker {
        constructor(url, options) {
            this.url = url;
            this.options = options;
            created.push(this);
        }
    }

    const page = {
        console: { log() {}, warn() {}, error() {} },
        URL: class extends URL {
            static createObjectURL(blob) {
                const id = `blob:https://www.twitch.tv/${blobs.size}`;
                blobs.set(id, blob);
                return id;
            }
        },
        Blob: class {
            constructor(parts) {
                this.text = parts.join("");
            }
        },
        location: { href: "https://www.twitch.tv/somechannel", origin: "https://www.twitch.tv" },
        BroadcastChannel,
        postMessage: (data, origin) => posted.push({ data, origin }),
        document: { cookie, documentElement: { dataset: proxy ? { tw2kProxy: proxy } : {} } },
        XMLHttpRequest: class {
            open(method, url) {
                this.url = url;
            }
            send() {
                this.status = 200;
                this.responseText = "importScripts('https://assets.twitch.tv/assets/player-worker.js');";
            }
        },
        fetch: async (url, opts) => {
            fetchCalls.push({ url: String(url), opts });
            return { ok: true, headers: { get: (h) => relayHeaders[h] ?? "" } };
        },
        Worker: FakeWorker,
    };
    page.window = page;
    vm.createContext(page);
    vm.runInContext(HOOK_SRC, page);
    return { page, blobs, created, fetchCalls, posted, BroadcastChannel, relayHeaders };
}

// Run the code that hook.js generated for a worker in a fake worker scope
function runWorkerCode(code, { BroadcastChannel, relayHeaders = {} } = {}) {
    const imported = [];
    const fetchCalls = [];
    const scope = {
        console: { log() {}, warn() {}, error() {} },
        URL,
        BroadcastChannel,
        setTimeout,
        clearTimeout,
        importScripts: (u) => imported.push(u),
        fetch: async (url, opts) => {
            fetchCalls.push({ url: String(url), opts });
            return { ok: true, headers: { get: (h) => relayHeaders[h] ?? "" } };
        },
    };
    scope.self = scope;
    vm.createContext(scope);
    vm.runInContext(code, scope);
    return { scope, imported, fetchCalls };
}

test("wraps Worker and keeps the original script", () => {
    const { page, blobs, created } = loadHook();
    new page.Worker("https://assets.twitch.tv/assets/player-worker.js");
    const code = blobs.get(created[0].url).text;
    const { imported } = runWorkerCode(code);
    assert.deepEqual(imported, ["https://assets.twitch.tv/assets/player-worker.js"]);
});

test("inlines blob worker sources", () => {
    const { page, blobs, created } = loadHook();
    new page.Worker("blob:https://www.twitch.tv/original");
    const { imported } = runWorkerCode(blobs.get(created[0].url).text);
    assert.deepEqual(imported, ["https://assets.twitch.tv/assets/player-worker.js"]);
});

test("worker sends usher playlists to the relay with auth", async () => {
    const { page, blobs, created } = loadHook();
    new page.Worker("https://assets.twitch.tv/assets/player-worker.js");
    const { scope, fetchCalls } = runWorkerCode(blobs.get(created[0].url).text);

    await scope.fetch("https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8?a=1");
    assert.equal(fetchCalls[0].url, PROXY);
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.equal(body.type, "usher");
    assert.equal(body.auth, `OAuth ${TOKEN}`);
});

test("worker leaves other requests alone", async () => {
    const { page, blobs, created } = loadHook();
    new page.Worker("https://assets.twitch.tv/assets/player-worker.js");
    const { scope, fetchCalls } = runWorkerCode(blobs.get(created[0].url).text);

    await scope.fetch("https://video-weaver.example.hls.ttvnw.net/v1/segment/abc.ts");
    assert.equal(fetchCalls[0].url, "https://video-weaver.example.hls.ttvnw.net/v1/segment/abc.ts");
});

test("does nothing to workers when the extension is off", () => {
    const { page, created } = loadHook({ proxy: "" });
    new page.Worker("https://assets.twitch.tv/assets/player-worker.js");
    assert.equal(created[0].url, "https://assets.twitch.tv/assets/player-worker.js");
});

test("module workers are not wrapped", () => {
    const { page, created } = loadHook();
    new page.Worker("https://assets.twitch.tv/assets/m.js", { type: "module" });
    assert.equal(created[0].url, "https://assets.twitch.tv/assets/m.js");
});

test("worker reports the granted quality to the page, page forwards it to the bridge", async () => {
    const relayHeaders = { "X-TW2K-MaxRes": "QUAD_HD", "X-TW2K-Reasons": "{}", "X-TW2K-Height": "1440" };
    const env = loadHook({ relayHeaders });
    new env.page.Worker("https://assets.twitch.tv/assets/player-worker.js");
    const { scope } = runWorkerCode(env.blobs.get(env.created[0].url).text, {
        BroadcastChannel: env.BroadcastChannel,
        relayHeaders,
    });

    await scope.fetch("https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8");
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(env.posted.length, 1);
    assert.equal(env.posted[0].origin, "https://www.twitch.tv");
    assert.equal(env.posted[0].data.__tw2k, "status");
    assert.equal(env.posted[0].data.status.ok, true);
    assert.equal(env.posted[0].data.status.maxRes, "QUAD_HD");
    assert.equal(env.posted[0].data.status.height, 1440);
});

test("worker asks the page for the current login on each request", async () => {
    const env = loadHook({ cookie: "auth-token=oldtokenoldtokenoldtokenold" });
    new env.page.Worker("https://assets.twitch.tv/assets/player-worker.js");
    const { scope, fetchCalls } = runWorkerCode(env.blobs.get(env.created[0].url).text, {
        BroadcastChannel: env.BroadcastChannel,
    });

    // Viewer logs in to another account after the player was created.
    env.page.document.cookie = `auth-token=${TOKEN}`;
    await scope.fetch("https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8");
    assert.equal(JSON.parse(fetchCalls[0].opts.body).auth, `OAuth ${TOKEN}`);

    // Logs out.
    env.page.document.cookie = "";
    await scope.fetch("https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8");
    assert.equal(JSON.parse(fetchCalls[1].opts.body).auth, "");
});

test("worker falls back to the captured login if the page doesn't answer", async () => {
    const env = loadHook();
    new env.page.Worker("https://assets.twitch.tv/assets/player-worker.js");
    // A bus the page is not on: nobody answers.
    const { scope, fetchCalls } = runWorkerCode(env.blobs.get(env.created[0].url).text, {
        BroadcastChannel: makeBus(),
    });
    await scope.fetch("https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8");
    assert.equal(JSON.parse(fetchCalls[0].opts.body).auth, `OAuth ${TOKEN}`);
});

test("status from another tab's player is ignored", async () => {
    const relayHeaders = { "X-TW2K-MaxRes": "QUAD_HD", "X-TW2K-Reasons": "{}" };
    const tabA = loadHook({ relayHeaders });
    const BroadcastChannel = tabA.BroadcastChannel;

    new tabA.page.Worker("https://assets.twitch.tv/assets/player-worker.js");
    const { scope } = runWorkerCode(tabA.blobs.get(tabA.created[0].url).text, { BroadcastChannel, relayHeaders });

    // Another tab's player posts on the same channel with its own page id
    const foreign = new BroadcastChannel("tw2k-relay");
    foreign.postMessage({ type: "status", pageId: "other-tab", status: { ok: true, maxRes: "FULL_HD" } });

    await scope.fetch("https://usher.ttvnw.net/api/v2/channel/hls/somechannel.m3u8");
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(tabA.posted.length, 1);
    assert.equal(tabA.posted[0].data.status.maxRes, "QUAD_HD");
});
