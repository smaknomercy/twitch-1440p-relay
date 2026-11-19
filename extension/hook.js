// ============================================================
// Twitch 1440p Relay — hook (MAIN world, document_start)
// ============================================================
// Twitch's player fetches the usher master playlist from inside
// a Web Worker, where a window.fetch patch cannot reach.
// So we:
//   1. patch fetch in the main window (in case it's fetched there), and
//   2. wrap window.Worker so every new worker gets the same fetch
//      patch injected before the player code runs.
// Only usher master-playlist requests are sent to the relay.
//
// Results are reported to the extension (toolbar badge):
//   worker --BroadcastChannel--> page --postMessage--> bridge.js
// ============================================================

(function () {
    "use strict";

    // Self-contained: this function is also stringified into workers.
    function installFetchPatch(scope, getProxy, getAuth, report, tag) {
        if (scope.__tw2kPatched) return;
        scope.__tw2kPatched = true;

        const nativeFetch = scope.fetch.bind(scope);

        scope.fetch = async function (input, init) {
            let url = "";
            try {
                url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                            ? input.href
                            : (input && input.url) || "";
            } catch {}

            const proxy = getProxy();
            if (proxy && url.includes("usher.ttvnw.net/") && url.includes(".m3u8")) {
                try {
                    const auth = await getAuth();
                    const r = await nativeFetch(proxy, {
                        method: "POST",
                        body: JSON.stringify({ type: "usher", url, auth }),
                    });
                    if (r.ok) {
                        let reasons = {};
                        try {
                            reasons = JSON.parse(r.headers.get("X-TW2K-Reasons") || "{}");
                        } catch {}
                        report({
                            ok: true,
                            maxRes: r.headers.get("X-TW2K-MaxRes") || "",
                            height: Number(r.headers.get("X-TW2K-Height")) || 0,
                            reasons,
                        });
                        console.log(
                            tag,
                            "Usher playlist via relay. Max resolution:",
                            r.headers.get("X-TW2K-MaxRes") || "?",
                            "| limits:",
                            r.headers.get("X-TW2K-Reasons") || "?",
                            "| logged in:",
                            auth ? "yes" : "no"
                        );
                        return r;
                    }
                    let detail = "";
                    try {
                        detail = (await r.text()).slice(0, 200);
                    } catch {}
                    report({ ok: false, error: `relay ${r.status}` });
                    console.warn(tag, "Relay returned", r.status, detail, "— falling back to direct");
                } catch (e) {
                    report({ ok: false, error: "relay unreachable" });
                    console.warn(tag, "Relay failed — falling back to direct:", e);
                }
            }
            return nativeFetch(input, init);
        };

        console.log(tag, "fetch patch installed");
    }

    const TAG = "[Twitch 2K]";
    const CHANNEL = "tw2k-relay";
    // BroadcastChannel reaches every Twitch tab; tag messages with this page's id.
    const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const getProxy = () => document.documentElement.dataset.tw2kProxy || "";

    // Twitch keeps the session OAuth token in the "auth-token" cookie.
    function getAuth() {
        const m = document.cookie.match(/(?:^|;\s*)auth-token=([^;]+)/);
        return m ? "OAuth " + decodeURIComponent(m[1]) : "";
    }

    // ---- Status reporting ----
    function reportToExtension(status) {
        window.postMessage({ __tw2k: "status", status }, location.origin);
    }

    // The page answers workers' auth requests with the current cookie,
    // so logging in or out doesn't require a page reload.
    try {
        const bc = new BroadcastChannel(CHANNEL);
        bc.onmessage = (e) => {
            const d = e.data;
            if (!d) return;
            if (d.pageId !== PAGE_ID) return;
            if (d.type === "status") reportToExtension(d.status);
            if (d.type === "auth-request") bc.postMessage({ type: "auth", pageId: PAGE_ID, id: d.id, auth: getAuth() });
        };
    } catch {}

    // Runs inside workers (stringified): ask the page for the current auth,
    // fall back to the value captured when the worker was created.
    function workerAuth(channelName, pageId, snapshot) {
        let bc = null;
        let seq = 0;
        const pending = new Map();
        return () =>
            new Promise((resolve) => {
                try {
                    if (!bc) {
                        bc = new BroadcastChannel(channelName);
                        bc.onmessage = (e) => {
                            const d = e.data;
                            if (d && d.type === "auth" && d.pageId === pageId && pending.has(d.id)) {
                                pending.get(d.id)(typeof d.auth === "string" ? d.auth : "");
                                pending.delete(d.id);
                            }
                        };
                    }
                    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}-${seq++}`;
                    const timer = setTimeout(() => {
                        pending.delete(id);
                        resolve(snapshot);
                    }, 500);
                    pending.set(id, (auth) => {
                        clearTimeout(timer);
                        resolve(auth);
                    });
                    bc.postMessage({ type: "auth-request", pageId, id });
                } catch {
                    resolve(snapshot);
                }
            });
    }

    // Runs inside workers (stringified): send status to the page.
    function workerReporter(channelName, pageId) {
        let bc = null;
        return (status) => {
            try {
                bc = bc || new BroadcastChannel(channelName);
                bc.postMessage({ type: "status", pageId, status });
            } catch {}
        };
    }

    // ---- 1. Main window ----
    installFetchPatch(window, getProxy, getAuth, reportToExtension, TAG);

    // ---- 2. Workers ----
    const NativeWorker = window.Worker;
    if (!NativeWorker || NativeWorker.__tw2k) return;

    function readBlobSync(blobUrl) {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", blobUrl, false); // sync on purpose: Worker constructor is sync
        xhr.send();
        return xhr.status === 200 || xhr.status === 0 ? xhr.responseText : null;
    }

    class TW2KWorker extends NativeWorker {
        constructor(scriptURL, options) {
            const proxy = getProxy();
            const isModule = options && options.type === "module";
            if (!proxy || isModule) {
                super(scriptURL, options);
                return;
            }

            const absUrl = new URL(String(scriptURL), location.href).href;
            let body;
            if (absUrl.startsWith("blob:")) {
                // Inline the original blob: it may be revoked right after construction.
                const src = readBlobSync(absUrl);
                body = src !== null ? src : `importScripts(${JSON.stringify(absUrl)});`;
            } else {
                body = `importScripts(${JSON.stringify(absUrl)});`;
            }

            const code =
                `(${installFetchPatch.toString()})(self, () => ${JSON.stringify(proxy)}, ` +
                `(${workerAuth.toString()})(${JSON.stringify(CHANNEL)}, ${JSON.stringify(PAGE_ID)}, ${JSON.stringify(getAuth())}), ` +
                `(${workerReporter.toString()})(${JSON.stringify(CHANNEL)}, ${JSON.stringify(PAGE_ID)}), "[Twitch 2K][worker]");\n` +
                body;
            const wrapped = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
            super(wrapped, options);
            console.log(TAG, "Hooked worker:", absUrl.slice(0, 100));
        }
    }
    TW2KWorker.__tw2k = true;

    window.Worker = TW2KWorker;
})();
