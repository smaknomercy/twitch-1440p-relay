# Changelog

## 3.2.0 — 2026-11-19

Update both the extension and the relay (`cd relay && npx wrangler deploy`).

- Popup: separate fields for the relay URL and key. Old settings are migrated automatically.
- Popup: **Test relay** button shows where Twitch sees the relay, whether your login is used, and the maximum quality Twitch grants.
- Toolbar badge per tab: the best quality the current stream offers (`2K`, `1080`, …), yellow with the reason in the tooltip if Twitch limits it, or `ERR`.
- Logging in or out of Twitch no longer requires reloading the stream page.
- Relay: `check` endpoint, `?vod=<id>` diagnostics, CORS for the extension popup.
- Relay refuses to run with a missing, short (< 16 chars) or placeholder `RELAY_KEY`.
- Deploy to Cloudflare button support (`relay/.dev.vars.example`).
- Tests (`npm test`) and CI; releases are built automatically from tags.
- Popup no longer loads fonts from Google.

## 3.1.0 — 2026-11-19

- Relay forwards the viewer's Twitch session token, so Twitch issues a 1440p (`QUAD_HD`) token. Without it Twitch answers `AUTHZ_NOT_LOGGED_IN`.

## 3.0.0 — 2026-11-19

- The extension wraps `window.Worker` and patches `fetch` inside the player's Web Worker, where Twitch now requests the usher playlist.
- The relay fetches a fresh `PlaybackAccessToken` itself and swaps it into the usher URL.
- `wrangler.toml` pins the relay near `aws:us-east-1`, so Twitch sees a US IP.
- Extension and relay moved into `extension/` and `relay/`.

## 2.0.1-security — 2026-11-19

- Relay requires an access key (`RELAY_KEY` secret, `?key=` in the URL).
- Usher URLs are validated by parsed hostname. Before, a substring check let the relay fetch arbitrary URLs.

## 2.0.1 and earlier

Original extension by [ddaccu](https://github.com/ddaccu/twitch-2k-unlocker).
