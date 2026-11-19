# Twitch 1440p Relay

Watch Twitch streams in **1440p (2K)** from regions where Twitch limits quality to 1080p — without a VPN.

A small Chrome extension plus a Cloudflare Worker **you deploy yourself**. Only the master playlist goes through the Worker; the video itself streams directly from Twitch, so there's no extra latency or bandwidth cost.

> Based on [ddaccu/twitch-2k-unlocker](https://github.com/ddaccu/twitch-2k-unlocker). The original approach stopped working once Twitch moved playlist requests into the player's Web Worker; this version is reworked to handle that and to fix a security issue in the relay.

## How it works

Twitch decides the maximum quality when it issues the **playback access token**. The token records your IP, and for some regions it caps the stream at `FULL_HD` with reason `AUTHZ_GEO`. Twitch also only grants 1440p to **logged-in** viewers (`AUTHZ_NOT_LOGGED_IN`).

```
Twitch player (Web Worker)     Your Cloudflare Worker (US)        Twitch
        │                                │                           │
        ├─ usher playlist request ──────►│                           │
        │                                ├─ PlaybackAccessToken ────►│  (as you, from a US IP)
        │                                │◄─ token: QUAD_HD ─────────┤
        │                                ├─ usher with new token ───►│
        │◄─ master playlist with 1440p ──┤◄─ playlist ───────────────┤
        │                                                            │
        ├─ video segments (direct, not proxied) ────────────────────►│
```

- `extension/hook.js` runs in the page and wraps `window.Worker`, injecting a `fetch` patch into the player's worker. Only usher `.m3u8` requests are redirected to your relay.
- `extension/bridge.js` passes the relay URL from extension storage to the page.
- `relay/worker.js` requests a fresh token from Twitch GQL, swaps it into the usher URL and returns the playlist.
- `relay/wrangler.toml` pins the Worker near `aws:us-east-1`. Without this, Cloudflare runs it in the data center closest to you, and Twitch sees your region again.

> 1440p only appears if the **streamer** broadcasts in 1440p (Enhanced Broadcasting). Twitch uses HEVC for it, so your browser needs HEVC hardware decoding (Chrome on recent macOS/Windows with hardware acceleration enabled).

## Security — read this

- **The relay receives your Twitch session token.** It's needed to get a 1440p token on your behalf. The relay forwards it to `gql.twitch.tv` only and never logs or stores it. **Only ever use a relay you deployed yourself.** Never paste someone else's Worker URL into the extension.
- The relay requires an access key (`?key=...`). Without it, it answers `403`, so nobody else can use your Worker or your quota.
- The relay only accepts `https://usher.ttvnw.net` URLs (checked by parsed hostname) and only issues `PlaybackAccessToken` queries.

## Setup

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and [Node.js](https://nodejs.org) 20+ (for `wrangler`).

### 1. Deploy the relay

```bash
git clone https://github.com/smaknomercy/twitch-1440p-relay.git
cd twitch-1440p-relay/relay

npx wrangler login     # opens the browser, click Allow
npx wrangler deploy    # prints your Worker URL: https://twitch-relay.<you>.workers.dev
```

The US placement from `wrangler.toml` is applied on deploy. It can't be set from the dashboard code editor, so deploy with `wrangler`.

### 2. Set the access key

```bash
openssl rand -hex 16          # copy the output
npx wrangler secret put RELAY_KEY   # paste it when asked
```

### 3. Check the relay

Open in the browser (use any live channel that streams in 1440p):

```
https://twitch-relay.<you>.workers.dev/?key=<YOUR_KEY>&channel=<channel>
```

You should see `"egress": { "country": "US", ... }`. The `token_check` there is anonymous, so it will show `AUTHZ_NOT_LOGGED_IN` for 1440p — that's expected; the extension sends your login.

### 4. Install the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.
3. Pin the extension, open its popup, paste `https://twitch-relay.<you>.workers.dev/?key=<YOUR_KEY>` and turn it on.
4. Reload the stream page.

## Troubleshooting

Open DevTools on the stream page (`Cmd+Option+J` / `Ctrl+Shift+J`) and filter the console by `Twitch 2K`.

| Console | Meaning |
|---|---|
| `Usher playlist via relay. Max resolution: QUAD_HD … logged in: yes` | Working. Pick 1440p in the player settings. |
| `Max resolution: FULL_HD`, limits `AUTHZ_GEO` | The relay isn't running in the US. Redeploy with `wrangler` and check `egress` in step 3. |
| `Max resolution: FULL_HD`, limits `AUTHZ_NOT_LOGGED_IN` | You're not logged in to Twitch, or the `auth-token` cookie wasn't found. |
| `Relay returned 403` | The key in the Worker URL doesn't match `RELAY_KEY`. |
| `Relay returned 502 …` | Twitch rejected the token request. The message after it says why. |
| No `Twitch 2K` lines at all | The extension is off, or the page wasn't reloaded after turning it on. |

## Limitations

- Twitch can change its player or token checks at any time and break this.
- The relay's token is requested from a different IP than yours. It works today, but Twitch could start enforcing a match.
- Bypassing regional restrictions may go against Twitch's Terms of Service. Use at your own risk.

## Credits

- Original extension: [ddaccu/twitch-2k-unlocker](https://github.com/ddaccu/twitch-2k-unlocker)
- Ideas from [TTV LOL PRO](https://github.com/younesaassila/ttv-lol-pro) and [K-Twitch-Bypass](https://github.com/Kwabang/K-Twitch-Bypass)

## License

MIT — see [LICENSE](LICENSE).
