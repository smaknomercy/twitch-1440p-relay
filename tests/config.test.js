import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../extension/config.js", import.meta.url), "utf8");

function loadConfig(stored = {}) {
    const data = { ...stored };
    const chrome = {
        storage: {
            local: {
                async get(keys) {
                    return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
                },
                async set(obj) {
                    Object.assign(data, obj);
                },
                async remove(key) {
                    delete data[key];
                },
            },
        },
    };
    const ctx = vm.createContext({ chrome, URL });
    vm.runInContext(SRC + "\nthis.TW2K = TW2K;", ctx);
    return { TW2K: ctx.TW2K, data };
}

test("splitUrl separates the key", () => {
    const { TW2K } = loadConfig();
    assert.deepEqual(
        { ...TW2K.splitUrl("https://twitch-relay.me.workers.dev/?key=abc123") },
        { url: "https://twitch-relay.me.workers.dev/", key: "abc123" }
    );
    assert.deepEqual(
        { ...TW2K.splitUrl("  https://twitch-relay.me.workers.dev  ") },
        { url: "https://twitch-relay.me.workers.dev/", key: "" }
    );
});

test("buildUrl adds key and extra params", () => {
    const { TW2K } = loadConfig();
    const u = new URL(TW2K.buildUrl("https://twitch-relay.me.workers.dev/", "abc", { channel: "x" }));
    assert.equal(u.searchParams.get("key"), "abc");
    assert.equal(u.searchParams.get("channel"), "x");
});

test("migrates the old single proxyUrl setting", async () => {
    const { TW2K, data } = loadConfig({ enabled: true, proxyUrl: "https://twitch-relay.me.workers.dev/?key=abc123" });
    const cfg = await TW2K.load();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.relayUrl, "https://twitch-relay.me.workers.dev/");
    assert.equal(cfg.relayKey, "abc123");
    assert.equal("proxyUrl" in data, false);
});
