# Exposing a self-hosted Minecraft server to the internet

**Status:** research, measured against primary sources — not a design decision yet.
**Question it answers:** which mechanism should Block Server Manager offer so a user can let friends join without
editing a router?

## The constraint that rules out most options

Minecraft **Java Edition** speaks a custom TCP protocol on port 25565 by default. It is **not HTTP and not TLS**. That
single fact eliminates most popular "tunnel" products, which are built for web traffic:

| Mechanism | Works for MC Java? | Why |
|---|---|---|
| **Tailscale Funnel** | **No** | Official docs: "Funnel can only listen on ports `443`, `8443`, and `10000`" and "Funnel only works over TLS-encrypted connections". Minecraft sends raw TCP; there is no TLS to terminate. |
| Cloudflare Tunnel (public hostname) | **No** for MC Java | Same reason — the free `cloudflared` HTTP path terminates TLS at Cloudflare and forwards HTTP. Cloudflare *Spectrum* can proxy arbitrary TCP, but it is a paid enterprise add-on. |
| ngrok free tier | Partially | TCP tunnels require a paid plan; the free plan is HTTP only. |
| **playit.gg** | **Yes** | Purpose-built for game servers; advertises "Minecraft Java" as a free-tier tunnel type. |
| **Direct port forwarding** | Yes | Requires router access and a public IP. Fails under CGNAT, which is common on mobile/fibre ISPs. |
| **Self-hosted VPS + TCP relay** | Yes | Works anywhere, but the user must rent and maintain a VPS. |

Sources: Tailscale Funnel docs (`tailscale.com/kb/1223/funnel`) list the port and TLS limitations verbatim; playit.gg
markets Minecraft Java as a supported free tunnel; Cloudflare's community guidance for Minecraft points users to
ngrok/playit rather than Tunnel.

**Conclusion:** Tailscale Funnel and Cloudflare Tunnel are not viable for this feature. Offering them would produce a
button that cannot work, which is the failure mode this project exists to avoid.

## The two realistic options

### Option A — playit.gg agent

playit.gg runs a small agent on the host machine that maintains an outbound connection to their relay network. Players
connect to a hostname like `xx.ip.gl.ply.gg:47XXX`. No inbound port, no public IP, no router change, and it works under
CGNAT.

**Why it fits:** Minecraft Java is an explicitly supported free tunnel type, and the agent is a documented CLI
(`playit-cloud/playit-agent`, BSD-2-Clause, Rust).

**Integration shape:**
1. App downloads or locates the `playit` agent binary.
2. The user supplies a secret key (from the playit.gg dashboard) — or the app shows the claim URL the agent prints and
   opens a browser.
3. The agent runs as a child process; the app parses its stdout for the assigned address.
4. Status (connected / address / errors) surfaces in the server Overview tab.

**Honest limitations, which must appear in the UI and not just the docs:**
- **The user must create a playit.gg account and claim the agent in a browser.** This cannot be automated. Any design
  that suggests "one click and you are public" is lying.
- Traffic goes through a third party that can see connection metadata, and the free tier has no uptime guarantee.
- The agent is a **third-party binary the app downloads and runs**. That is a real trust decision, comparable to the
  existing Java-runtime download — it needs an allowlisted host, checksum verification, and a clear statement that the
  app is executing someone else's code on the user's behalf.
- Custom domains and some tunnel types are behind playit Premium (~$3/month). That is the user's cost, not the app's.

### Option B — guided direct port forwarding

The app cannot change router settings. What it *can* do is remove the guesswork:

1. Detect the machine's LAN IP and whether a public IP is reachable (which also detects CGNAT, the case where port
   forwarding cannot work at all).
2. Test whether the port is actually reachable from outside (a small echo service or an existing public checker).
3. Show step-by-step router instructions for the detected situation, plus a firewall rule command.
4. Verify the result and show the address friends should use.

**Why it is worth doing even though it is "just" guidance:** it is the option with no third party, no account, and no
extra binary — and it is the only one that works offline once configured. It is also the only one that can *tell the
user it is impossible* (CGNAT detected) instead of leaving them to discover that after an hour of router menus.

## Recommendation

Do **B before A**. Rationale:

- **B has no third-party dependency and no new binary to trust.** It is analysable, testable offline (the detection
  logic), and degrades to a clear "your ISP uses CGNAT, so this cannot work; here is the alternative".
- **A's value depends on a user account the app cannot create.** Offering B first means users who can port-forward get a
  working solution without ever seeing a third-party service.
- **A can then be positioned as the CGNAT fallback**, which is exactly the case where B cannot help. That is a coherent
  story: "we try direct first, and if your ISP makes that impossible, here is a tunnel."

Doing A first would mean every user — including those for whom direct forwarding is trivial — is pushed to a third
party for no reason.

## What is E4 today (design only, not proven)

Nothing in this document has been built. By this project's standard (`docs/audit/19`), the whole feature is **E4** —
design only. It becomes E2 only when a real server is reachable from a machine outside the local network through the
implemented mechanism, with the address confirmed from that outside machine. A unit test asserting "the parser found a
hostname" proves nothing about reachability.

## Open questions to settle before implementation

1. **Where does the playit agent binary live?** Bundling it adds ~10 MB to the installer and makes the app responsible
   for updating it. Downloading on first use means a checksum-pinned allowlist entry and a failure path for offline
   users. The existing Java-runtime download is the precedent, and it favours downloading.
2. **Does "public" need to survive an app restart?** A tunnel that silently dies when the app closes is expected; one
   that dies when the *server* restarts is a support burden. The agent should outlive server restarts.
3. **What does the UI show when the tunnel is up but the server is stopped?** The address is allocated by playit, not by
   the server, so it exists regardless. Showing a "join at X" address that leads nowhere is worse than showing nothing.
4. **Security posture.** Exposing a server publicly removes the implicit LAN protection. The app should refuse to
   expose a server with `online-mode=false` unless the user acknowledges it explicitly — offline-mode servers are
   trivially impersonated.
