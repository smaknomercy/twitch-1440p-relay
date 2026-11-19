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
                    const r = await nativeFetch(proxy, {
                        method: "POST",
                        body: JSON.stringify({ type: "usher", url, auth: getAuth() }),
                    });
                    if (r.ok) {
                        let reasons = {};
                        try {
                            reasons = JSON.parse(r.headers.get("X-TW2K-Reasons") || "{}");
                        } catch {}
                        report({ ok: true, maxRes: r.headers.get("X-TW2K-MaxRes") || "", reasons });
                        console.log(
                            tag,
                            "Usher playlist via relay. Max resolution:",
                            r.headers.get("X-TW2K-MaxRes") || "?",
                            "| limits:",
                            r.headers.get("X-TW2K-Reasons") || "?",
                            "| logged in:",
                            getAuth() ? "yes" : "no"
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

    try {
        const bc = new BroadcastChannel(CHANNEL);
        bc.onmessage = (e) => {
            if (e.data && e.data.type === "status") reportToExtension(e.data.status);
        };
    } catch {}

    // Runs inside workers (stringified): send status to the page.
    function workerReporter(channelName) {
        let bc = null;
        return (status) => {
            try {
                bc = bc || new BroadcastChannel(channelName);
                bc.postMessage({ type: "status", status });
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
                `(${installFetchPatch.toString()})(self, () => ${JSON.stringify(proxy)}, () => ${JSON.stringify(getAuth())}, ` +
                `(${workerReporter.toString()})(${JSON.stringify(CHANNEL)}), "[Twitch 2K][worker]");\n` +
                body;
            const wrapped = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
            super(wrapped, options);
            console.log(TAG, "Hooked worker:", absUrl.slice(0, 100));
        }
    }
    TW2KWorker.__tw2k = true;

    window.Worker = TW2KWorker;
})();
