# Browser console

Vargos can launch Playwright’s dashboard alongside the daemon. The **Browser**
sidebar link opens it in a new tab, where you can view and interact with browsers
registered by Playwright. No separate systemd service is needed.

The dashboard is optional and binds to **127.0.0.1:9005**. The sidebar route
`/browser` redirects to its configured URL; it does not proxy or embed the dashboard.

## Prerequisites

- An enabled, connected Playwright MCP server, named `playwright` by default.
- An installed Playwright version containing `playwright-core/lib/entry/dashboardApp.js`.
- A browser attached through MCP. If MCP uses a CDP endpoint, start that browser
  separately; this service starts the dashboard, not Chromium.
- Run the dashboard under the same account/runtime environment as Playwright MCP
  so it can discover the browser registry.

The deployment tested on 2026-11-04 used Playwright Core
`1.65.0-alpha-2026-10-30`. The dashboard entrypoint is internal: verify compatibility
when upgrading. Vargos does not install Playwright or select an npx cache entry for you.

## Configure Vargos

Set these in the environment of the existing Vargos service:

```ini
Environment="VARGOS_BROWSER_SCRIPT=/absolute/path/to/playwright-core/lib/entry/dashboardApp.js"
Environment="VARGOS_DASHBOARD_PORT=9005"
Environment="VARGOS_BROWSER_URL=https://browser.example.com"
Environment="VARGOS_BROWSER_MCP_SERVER=playwright"
```

| Setting | Default / behavior |
| --- | --- |
| `VARGOS_BROWSER_SCRIPT` | Required absolute script path; absent/missing disables the dashboard |
| `VARGOS_DASHBOARD_PORT` | `9005`; listener always binds to loopback |
| `VARGOS_BROWSER_URL` | `http://127.0.0.1:<port>`; destination of the sidebar link |
| `VARGOS_BROWSER_MCP_SERVER` | `playwright`; name in `mcp.list` |

Choose a known installed script path. An npx cache path can disappear when the
cache is cleaned; a stable, version-pinned installation is preferable for deployment.
Do not confuse `VARGOS_DASHBOARD_PORT` with a Chromium CDP port such as `9222`.

Edit your source unit file. For this repository, `~/apps/vargos.service` is the
source of truth; installed units should link to it. After editing, reload the
appropriate systemd manager and restart Vargos. For a user service:

```bash
systemctl --user daemon-reload
systemctl --user restart vargos.service
```

For a system service, use `sudo systemctl` without `--user`. Do not run both a manual
`vargos start` and a systemd instance against the same ports.

A source/tsx deployment picks up source changes on restart. A packaged deployment
requires rebuilding and deploying `dist/` first. Check `ExecStart` and its launcher
rather than assuming which mode is running.

## Local access

On the Vargos machine:

```bash
curl -i http://127.0.0.1:9005/
curl -L http://127.0.0.1:9005/
vargos browser status
```

The root returns **302 with an empty body**, redirecting to
`/index.html?ws=<id>`. Plain `curl` therefore prints nothing; `-L` follows the
redirect and returns HTML.

The machine’s LAN IP will not accept connections on this port. For private access
from another computer, forward the loopback port:

```bash
ssh -N -L 9005:127.0.0.1:9005 user@vargos-host
```

Then open `http://127.0.0.1:9005` on that computer. No public tunnel is needed.

## Cloudflare Tunnel

Use a dedicated hostname. Playwright serves assets and its WebSocket at root
paths, so routing only `/browser` to it is insufficient.

Protect the hostname with an appropriate Cloudflare Access policy before publishing
browser control. Browser users need an interactive login policy; API callers may
use a Service Auth policy. A token accepted for another hostname is not proof that
this application permits it. Keep tokens out of frontend code, URLs, and logs.

Add this rule **before the fallback rule** in your existing tunnel config:

```yaml
ingress:
  # Other hostname rules...
  - hostname: browser.example.com
    service: http://127.0.0.1:9005
    originRequest:
      httpHostHeader: localhost
  - service: http_status:404
```

The Host override is required by the tested dashboard version: when bound to
loopback, Playwright rejects an external Host header with an empty **403**.
Cloudflared must forward `Host: localhost`. This is not authentication; Access
protects the publicly reachable browser. See
[Cloudflare origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).

Create the DNS route and validate the forwarding rule, substituting your tunnel
name and config path:

```bash
cloudflared tunnel route dns <tunnel-name> browser.example.com
cloudflared tunnel --config /path/to/config.yml ingress validate
cloudflared tunnel --config /path/to/config.yml ingress rule https://browser.example.com
```

DNS routing and ingress forwarding are separate steps. Restart your cloudflared
service to load the edited config. In this deployment it is a user service:

```bash
systemctl --user restart cloudflared-vargos.service
```

Open the Browser link after login. Verify both the page and its WebSocket connection;
a successful HTML response alone does not verify live browser control.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Empty output from plain curl | Expected root redirect; use `curl -i` or `curl -L` |
| Local connection refused | `vargos browser status`, service journal, script path, and port listener |
| Disabled/disconnected MCP | Enable/connect the configured MCP server, then restart Vargos or reload `edge-browser` |
| Dashboard is empty | Make a harmless MCP browser call to attach a browser; check the configured CDP browser is running |
| Public HTTP 403, local HTTP 200/302 | Reproduce with a public Host header locally; check the Host override before blaming Access |
| Redirect to Cloudflare login | Expected without a valid Access session; use the intended login or service-token policy |
| NXDOMAIN | Compare LAN DNS with public DNS; a cached negative response may persist after record creation |
| LAN IP does not connect | Listener is loopback-only; use the tunnel or SSH forwarding |
| Address already in use | Check the current listener and log timestamps; avoid duplicate daemon/dashboard instances |

To distinguish Playwright’s Host rejection from Cloudflare authentication:

```bash
curl -i -H 'Host: browser.example.com' http://127.0.0.1:9005/
curl -i -H 'Host: localhost' http://127.0.0.1:9005/
```

The first returned 403 and the second 302 in the tested version. A `server:
cloudflare` response header alone does not identify where an error originated.

For DNS diagnosis without changing resolver settings:

```bash
dig browser.example.com
dig @1.1.1.1 browser.example.com
```

If public DNS resolves but the local resolver does not, restarting Vargos cannot
fix that cache. Do not disable Access to troubleshoot DNS or origin Host rejection.

## Behavior and limits

- Disabled/disconnected Playwright MCP skips dashboard startup. This check runs at
  initialization; configuration changes require reloading the browser edge or daemon.
- Missing software or dashboard startup failure leaves the feature unavailable;
  `browser.status` reports `port`, `url`, `running`, `pid`, and `reason`.
- An existing Playwright dashboard singleton is not adopted or killed. This edge
  manages only its own child, with bounded shutdown.
- There is no automatic takeover lock. Keep the agent idle while entering credentials
  or interacting manually, then resume it yourself.
- Closing a dashboard session can close browser contexts. Do not use it as a harmless
  disconnect button for a shared browser. Shared-session close behavior is not certified.
- Manual viewing does not guarantee that every CAPTCHA or website will work.

Verification covered lifecycle tests, local HTML, public HTML, and a public WebSocket
connection receiving a `tabs` message. That does not establish successful interaction
with every site or preservation of a shared session after closing it.

## Disable

Remove `VARGOS_BROWSER_SCRIPT` from the service environment and restart Vargos.
Remove the browser ingress and DNS record when no longer needed, then restart the
tunnel. The navigation entry remains but reports that the dashboard is unavailable.
