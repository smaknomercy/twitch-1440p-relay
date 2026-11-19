import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const HOOK_SRC = readFileSync(new URL("../extension/hook.js", import.meta.url), "utf8");
const PROXY = "https://relay.example.workers.dev/?key=k";
const TOKEN = "abcdefghijklmnopqrstuvwxyz0123";

// Minimal page environment for hook.js
function loadHook({ proxy = PROXY, cookie = `x=1; auth-token=${TOKEN}` } = {}) {
    const blobs = new Map();
    const created = [];
    const fetchCalls = [];

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
        location: { href: "https://www.twitch.tv/somechannel" },
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
            return { ok: true, headers: { get: () => "" } };
        },
        Worker: FakeWorker,
    };
    page.window = page;
    vm.createContext(page);
    vm.runInContext(HOOK_SRC, page);
    return { page, blobs, created, fetchCalls, FakeWorker };
}

// Run the code that hook.js generated for a worker in a fake worker scope
function runWorkerCode(code) {
    const imported = [];
    const fetchCalls = [];
    const scope = {
        console: { log() {}, warn() {}, error() {} },
        URL,
        importScripts: (u) => imported.push(u),
        fetch: async (url, opts) => {
            fetchCalls.push({ url: String(url), opts });
            return { ok: true, headers: { get: () => "" } };
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
