# Research Follow-up — Embedded CurseForge Download Handoff

**Date:** 2026-10-10  
**Related:** [CurseForge server-pack import](2026-10-10-curseforge-server-pack-import.md), [WebView2 bridge follow-up](2026-10-10-curseforge-webview2-bridge-follow-up.md)

## User evidence

The user reports that the official server-pack ZIP `Prominence™_II_Hasturian_Era_v.4.1.3_server_pack cf.zip` downloads successfully in an external browser. In the embedded browser, CurseForge stays on its download countdown and the app shows no managed-download row. CurseForge's official file page identifies file 9094783 as the v4.1.3 server pack, a 1.1 GB Fabric pack for Minecraft 1.20.1. The external-browser success is user-provided evidence; the app has not yet been smoke-tested against this live file.

## Code-path finding

The dedicated webview's Tauri `on_navigation` filter now permits HTTPS `curseforge.com` + `forgecdn.net` (exact hosts + true subdomains; see `src-tauri/src/modpacks/curseforge_import.rs:1901-1910`). The managed transfer row is created later by the Tauri `on_download` callback, and the Windows bridge attaches to WebView2's `DownloadStarting` event. CurseForge's official download documentation says website downloads are delivered from `edge.forgecdn.net`; its official page says website users need no API key because the website handles this for them.

**Likely cause (inference):** the browser policy rejects the official CurseForge CDN redirect before WebView2 raises the download event observed by the app. That leaves CurseForge's countdown page visible and prevents a transfer row from appearing, while a normal external browser follows the redirect. Microsoft documents that WebView2's `NavigationStarting` handlers can block navigation and that HTTP redirects trigger additional navigation-start events. The source evidence supports the allowlist as the likely app-side fault; no live WebView2 event trace has yet confirmed the exact redirect host for this user's download.

## Implementation guidance

- Keep HTTPS required.
- Permit `curseforge.com` and its true subdomains as before.
- Permit the official CDN root `forgecdn.net` and true subdomains such as `edge.forgecdn.net`, without permitting lookalikes like `forgecdn.net.attacker.example`.
- Keep unrelated domains, non-HTTPS schemes, and main-app capabilities blocked. Do not reconstruct or fetch the CDN URL from Rust; let the official website/WebView2 handle its own redirect and cookies.
- Add pure regression tests for exact root/subdomain matching, HTTPS-only behavior, and lookalike rejection. Then manually smoke-test a live SERVER ZIP on Windows because the unit tests cannot prove the WebView2 redirect/event ordering.

## Sources

- [CurseForge file page for Prominence II server pack 4.1.3, file 9094783](https://www.curseforge.com/minecraft/modpacks/prominence-2-hasturian-era/files/9094783)
- [CurseForge: API-key authentication for direct CDN downloads](https://blog.curseforge.com/introducing-api-key-authentication-for-curseforge-file-downloads/) — identifies `edge.forgecdn.net` and says website downloads are handled by the site.
- [Microsoft WebView2 navigation events](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/navigation-events) — `NavigationStarting` can disallow a navigation; redirects trigger additional events.
- [Microsoft WebView2 `NavigationStarting` API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2?view=webview2-1.0.3967.48) — navigation requests remain blocked until event handlers return.
- [Tauri `WebviewWindowBuilder::on_download`](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindowBuilder.html#method.on_download) — requested/finished download hook and cancellation return behavior.
- [Wry WebView2 download handler source](https://github.com/tauri-apps/wry/blob/dev/src/webview2/mod.rs) — Windows download hook is implemented via WebView2 `DownloadStarting`.
