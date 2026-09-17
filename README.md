# merge-gateway-shim

A small local proxy that lets **Cursor's Agent mode** and **Xcode's chat** route
through **[Merge Gateway](https://docs.merge.dev/merge-gateway/get-started)**.

Both editors can be pointed at one running shim on one port, and that is the
case it is built for. They place different demands on it — Cursor sends a
mismatched request dialect, Xcode sends ordinary Chat Completions and has
nowhere to put an API key — and each was fixed in a way that would have broken
the other if done naively.

Merge's own docs describe the Cursor side of the problem this solves:

> Cursor's Agent mode does not currently support custom API keys. Only Ask and
> Plan modes work with a custom OpenAI base URL. […] This is a Cursor-side
> restriction; Gateway itself handles agentic workloads fine.

The restriction is a wire-format mismatch inside Cursor's BYOK path, and it is
fixable from the outside.

- **[Setting up Cursor](#step-2--point-cursor-at-the-shim)**
- **[Setting up Xcode](#setting-up-xcode)**
- **[Running both at once](#serving-cursor-and-xcode-at-once)**

## The problem

There are four distinct faults, and they are worth separating because two of
them look identical from the outside and only one is Cursor's.

### 1. Cursor asks in one dialect and expects the answer in another

When Cursor is pointed at a custom OpenAI base URL, its Agent mode is
self-inconsistent:

| Layer | What Cursor uses |
| --- | --- |
| Request path | `POST {base}/chat/completions` |
| Request body | **Responses** shape — `input[]`, flat `tools[]`, `reasoning`, `text`, `include`, `store` |
| Response parser | **Chat Completions** SSE — `choices[].delta`, `finish_reason` |

Three consequences:

- A strict Chat Completions upstream rejects the body with
  `Missing required parameter: 'messages'`.
- `stream_options: {include_usage: true}` is sent, which is a Chat
  Completions-only field the Responses API rejects.
- Tools arrive as `{"type":"custom","name":"ApplyPatch","format":{"type":"grammar",…}}`
  — a Responses-only shape with no Chat Completions equivalent. This one
  specifically breaks **file edits** while chat keeps working, which is the
  "the agent replies but never applies changes" symptom.

There is also an unrelated Cursor bug where a custom model id colliding with a
catalog name gets rewritten before it leaves (`glm-5.2` → `glm-5.2-high`), which
matters because Gateway ids are `provider/model`.

Cursor sometimes mixes shapes in a single request: a Chat Completions top level
carrying one stray `type:"custom"` tool.

### 2. Gateway answers in a dialect Cursor does not render

This one affects every client and is the reason Agent mode sat on *Planning next
moves* → *Reconnecting* forever with no error shown. Gateway names the reasoning
field `delta.thinking`; Cursor renders `delta.reasoning` and ignores the rest, so
the entire reasoning phase was discarded and the model looked like it was doing
nothing. See [Response translation](#response-translation).

### 3. A reasoning turn that cannot be replayed

Some providers reject the second turn of a tool conversation unless the previous
turn's reasoning is echoed back, which agent clients do not preserve. That is a
`400` and a retry loop. See
[Reasoning models and the agent loop](#reasoning-models-and-the-agent-loop).

### 4. One port, two clients that disagree about paths and keys

Xcode's local provider mode has nowhere to put an API key, and builds its own
`/v1` prefix; Cursor takes the base URL verbatim and does send a key. Requiring
the key everywhere locks Xcode out; not requiring it leaves a tunnel open. See
[Serving Cursor and Xcode at once](#serving-cursor-and-xcode-at-once).

## The fix

```
        Cursor (Agent mode)              Xcode (chat)
   request:  Responses-shaped        request:  Chat Completions
   path:     /v1/chat/completions    path:     /v1/v1/chat/completions
   key:      sent                    key:      none available
                     │                          │
                     └────────────┬─────────────┘
                                  ▼
                    merge-gateway-shim  (localhost:8787)
                     1. classify the body
                     2. capture it to disk (credentials redacted)
                     3. normalise → strict Chat Completions
                     4. exempt local requests from the client key
                                  │
                                  ▼
                Merge Gateway   /v1/openai/chat/completions
                                  │  standard OpenAI SSE
                                  ▼
                    merge-gateway-shim
                     5. reshape the response for Cursor
                        (thinking → reasoning, drop no-ops)
                                  │
                                  ▼
              Cursor  ✓ renders reasoning, calls tools, applies edits
              Xcode   ✓ renders, calls tools
```

Normalising **down** to Chat Completions is deliberate: Gateway's OpenAI surface
is its best-tested path, so routing, failover, budgets, and cost attribution all
keep working, and only one dialect has to be understood.

Gateway already exposes both dialects, so nothing is needed from Merge:

```
POST /v1/openai/chat/completions   native OpenAI surface   ← the shim targets this
POST /v1/openai/responses          OpenAI-shaped Responses
POST /v1/responses                 Gateway-native Responses
```


## Requirements

- Node.js 20.12+ (uses `process.loadEnvFile`; older runtimes fall back to a
  built-in parser)
- A Merge Gateway API key from [dashboard.merge.dev](https://dashboard.merge.dev)
- At least one of:
  - **Cursor**, with Agent mode — [download](https://cursor.com/downloads)
    (macOS, Windows, and Linux)
  - **Xcode**, for its chat provider — see [Setting up Xcode](#setting-up-xcode)

Both editors can share one shim, so install both if you want. Xcode additionally
requires **Apple Intelligence** enabled in
**System Settings → Apple Intelligence & Siri**; without it Xcode cannot use any
provider, and it fails quietly.

## Install

### macOS

Node is the only dependency. If you use [Homebrew](https://brew.sh):

```sh
brew install node
```

Otherwise install the official package from [nodejs.org](https://nodejs.org).
Either way, confirm you are on 20.12 or newer — `node --version`.

Then clone and build:

```sh
git clone https://github.com/659jwwrq9m-code/Merge-Gateway-For-Cursor.git
cd Merge-Gateway-For-Cursor
npm install
npm run build
```

### Windows

Install Node from [nodejs.org](https://nodejs.org) or with winget:

```powershell
winget install OpenJS.NodeJS.LTS
```

Use **PowerShell** rather than `cmd.exe`. Confirm `node --version` reports 20.12
or newer, then:

```powershell
git clone https://github.com/659jwwrq9m-code/Merge-Gateway-For-Cursor.git
cd Merge-Gateway-For-Cursor
npm install
npm run build
```

Two Windows specifics:

- If `git` or `node` is not recognised, reopen PowerShell. The installer updates
  `PATH`, but an already-open shell keeps the old one.
- Long paths can break `npm install`. If it fails on a deep dependency, enable
  them once from an **Administrator** PowerShell:

  ```powershell
  git config --global core.longpaths true
  ```

`npm start` and `npm test` are identical across both platforms. Where the two
differ is environment variables — see
[Environment variables per platform](#environment-variables-per-platform).

### Linux

Cursor ships a Linux build (`.deb`, `.rpm`, and AppImage, for x64 and ARM64),
so the shim works there too.

Install Node 20.12+ first — use your distribution's packages rather than a
download, so the runtime stays patched:

```sh
# Debian / Ubuntu
sudo apt install nodejs npm

# Fedora / RHEL
sudo dnf install nodejs npm

# Arch
sudo pacman -S nodejs npm
```

Distribution packages often lag. Check `node --version` and if it is below
20.12, use [nvm](https://github.com/nvm-sh/nvm) or
[nodesource](https://github.com/nodesource/distributions) instead.

Then clone and build:

```sh
git clone https://github.com/659jwwrq9m-code/Merge-Gateway-For-Cursor.git
cd Merge-Gateway-For-Cursor
npm install
npm run build
```

One Linux-specific note: **the shim binds loopback only by default, and that is
worth keeping** — it forwards your Gateway key. If you already run something on
port 8787, change `SHIM_PORT` rather than binding `0.0.0.0`.

## Setup

Copy the template and put your key in it:

```sh
# macOS and Linux
cp .env.example .env
```

```powershell
# Windows
Copy-Item .env.example .env
```

Use any editor to set your key in `.env`:

```ini
MERGE_GATEWAY_API_KEY=your_key_here
```

Then verify it:

```sh
npm run check:env
```

```
shim resolved configuration
  .env                /path/to/merge-gateway-shim/.env
  applied from .env   MERGE_GATEWAY_API_KEY
  gateway base url    https://api-gateway.merge.dev/v1/openai
  api key             mg_abc…9xyz (35 chars)
  listen              http://localhost:8787/v1
  mode                capture only (no upstream calls)
  capture dir         /path/to/merge-gateway-shim/captures
  cursor base url     http://localhost:8787/v1

shim verifying key against Gateway…
shim ✓ key accepted, 214 model(s) visible
```

`--check` needs no running server and spends no tokens: it calls
`GET /models`, which is authenticated but free, so it is real proof the key works
rather than just a format check.

### Environment precedence

Highest wins:

1. Command-line flags — `--port`, `--gateway-url`, …
2. Variables already in your shell
3. `.env` beside this project
4. Built-in defaults

`.env` sits *below* the ambient environment on purpose, so a key exported for one
run wins without editing the file:

```sh
# macOS and Linux
MERGE_GATEWAY_API_KEY=mg_other_key npm start
```

```powershell
# Windows PowerShell
$env:MERGE_GATEWAY_API_KEY = "mg_other_key"; npm start
```

`--check` reports which source each variable came from (`applied from .env` vs
`already in shell (shell wins)`), and the key is always masked.

### Environment variables per platform

`npm start` is the same everywhere. Setting a variable for a single run is not,
and `.env` means you rarely need to.

| | macOS / Linux (`bash`, `zsh`) | Windows (PowerShell) |
| --- | --- | --- |
| One run | `SHIM_PASSTHROUGH=1 npm start` | `$env:SHIM_PASSTHROUGH=1; npm start` |
| This session | `export SHIM_PASSTHROUGH=1` | `$env:SHIM_PASSTHROUGH = "1"` |
| Persist for user | add to `~/.zshrc` | `setx SHIM_PASSTHROUGH 1` (new shells only) |
| Unset | `unset SHIM_PASSTHROUGH` | `Remove-Item Env:SHIM_PASSTHROUGH` |

`setx` applies to *future* shells, not the current one — a common source of
confusion when the change appears not to take effect. And do not use `cmd.exe`
for these examples; `set VAR=1` works there, but the escaping differs and the
rest of this document assumes PowerShell.

The simplest path on every platform is to put the setting in `.env` and leave
shell variables alone.

## Step 1 — survey the traffic (capture mode)

**Capture mode is the default.** The shim records every request and answers
locally without ever contacting Gateway, so you can survey traffic without
spending anything.

```sh
npm start
```

Captures land in `captures/`, one full JSON per request plus a compact
`index.jsonl` you can read at a glance:

```sh
cat captures/index.jsonl
```

```json
{"seq":1,"method":"POST","path":"/v1/chat/completions","model":"anthropic/claude-opus-5",
 "kind":"responses","tools":"mixed","toolCount":2,"customTools":["ApplyPatch"],
 "stream":true,"responsesOnly":["input","instructions","include","reasoning","text"],"bytes":812}
```

That single line answers the questions this project exists to settle: which path
Cursor used, which dialect it sent, how the tools were shaped, and whether the
`ApplyPatch` custom tool is present.

Credentials are redacted on write — `Authorization: Bearer ••••`, keeping the
scheme so a capture still shows *how* auth was sent. Captures are safe to share.

## Step 2 — point Cursor at the shim

**Capture mode is the default**, so you can do this before spending anything.
The shim answers every request locally and records it.

In Cursor:

1. **Settings → Cursor Settings → Models**
2. Enable **OpenAI API Key** — see the note below on what goes here
3. Enable **Override OpenAI Base URL** → `http://localhost:8787/v1`
4. Click **+ Add Custom Model** and add a Gateway model id, e.g.
   `zai/glm-5.3-flash` or `anthropic/claude-opus-5`
5. Switch to **Agent mode** and send a message

**What to put in the API key field.** If you have not set `SHIM_CLIENT_KEY`, any
non-empty placeholder works — the shim holds the real Gateway key, and Cursor
only requires the field to be filled. If you *have* set `SHIM_CLIENT_KEY`, this
field must contain that exact value: it is the token the shim checks on every
request that can reach a completion. A wrong value here produces the shim's own
`401 invalid_api_key`, not a Gateway error.

Use `localhost` rather than `127.0.0.1`. The shim binds both loopback stacks,
and `localhost` is what Cursor and Xcode produce by default.

If you get connection or TLS errors, set
**Settings → Cursor Settings → Network → HTTP Compatibility Mode** to
**HTTP/1.1**. The same setting lives in the desktop and web settings panes.
Cursor defaults to HTTP/2, and many local proxies do not serve it.

### Model ids

Cursor rewrites a custom model id that collides with a name in its own catalogue
— `glm-5.2` becomes `glm-5.2-high` before it leaves. Gateway ids are
`provider/model`, which do not collide, so **always use the full
`provider/model` form** and you will not hit it.

If you also want Xcode pointed at this shim, **stop here and do
[Setting up Xcode](#setting-up-xcode) first** — it needs the shim running in
passthrough, but it needs none of the Cursor fields above.

## Step 3 — turn on passthrough

Once an editor is talking to the shim, forward to Gateway:

```sh
SHIM_PASSTHROUGH=1 npm start
```

```powershell
# Windows PowerShell
$env:SHIM_PASSTHROUGH=1; npm start
```

Or set it once in `.env` so it applies on every platform:

```ini
SHIM_PASSTHROUGH=1
```

Passthrough is off by default specifically so capture mode cannot spend money.
The shim says plainly when it is billing:

```
shim listening on http://localhost:8787/v1 · passthrough → Gateway
shim passthrough is on: requests will be forwarded to Gateway and billed.
```

### Verify without Cursor

Before blaming the editor, confirm the shim itself is healthy:

```sh
curl http://localhost:8787/health
```

```powershell
# Windows PowerShell
Invoke-RestMethod http://localhost:8787/health
```

That endpoint is open even when `SHIM_CLIENT_KEY` is set, so it is always safe
to check. Add `--check` for a fuller report that does not need the server
running and does not spend tokens:

```sh
npm run check:env
```

## Running it from anywhere

Cursor calls the base URL directly, so **the shim must already be running**. It
does not start anything for you, and a closed terminal takes it down.

### Keep it always running (macOS, recommended: launchd)

If the shim lives in a Cursor terminal — or any terminal — anything that quits
that app kills it with SIGKILL: no error, no log line, the port just goes dead
and Cursor starts reporting provider errors. A `launchd` user service avoids
that entirely: it runs outside Cursor, restarts the shim if it dies, starts on
login, and survives sleep and reboots.

Create `~/Library/LaunchAgents/com.chrisminshall.merge-gateway-shim.plist`
(adapt the label, node path, and paths to your setup — `which node` gives the
absolute node path, which launchd needs because it does not read nvm):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.chrisminshall.merge-gateway-shim</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/YOU/.nvm/versions/node/vX.Y.Z/bin/node</string>
      <string>dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/merge-gateway-shim</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>3</integer>
    <key>StandardOutPath</key>
    <string>/tmp/merge-gateway-shim.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/merge-gateway-shim.log</string>
  </dict>
</plist>
```

Load it and verify:

```sh
launchctl load ~/Library/LaunchAgents/com.chrisminshall.merge-gateway-shim.plist
curl http://127.0.0.1:8787/health   # {"status":"ok","mode":"passthrough"}
```

With `KeepAlive` on, `kill -9` on the shim gets answered by a fresh process
within a few seconds — verified by killing it and watching it come back. Manage
it with:

```sh
launchctl print gui/$(id -u)/com.chrisminshall.merge-gateway-shim  # status
launchctl kickstart -k gui/$(id -u)/com.chrisminshall.merge-gateway-shim  # restart
launchctl bootout gui/$(id -u)/com.chrisminshall.merge-gateway-shim  # stop & unload
```

The service log lands in `/tmp/merge-gateway-shim.log`. On Windows, use a
second PowerShell window, or register a scheduled task:

```powershell
Start-Process -NoNewWindow npm -ArgumentList "start" -RedirectStandardOutput shim.log
```

On Linux, the equivalent is a systemd user unit (`~/.config/systemd/user/` with
`Restart=always`, enabled via `systemctl --user enable --now`).

`npm start` binds loopback only, so nothing outside your machine can reach it —
which is why the key inside it stays safe. That changes the moment you expose
it, and the next section covers what to do about it.

## Reaching it from another machine (Cloudflare Tunnel)

Loopback is the right default: the shim holds your Gateway key, so anything that
can reach it can spend your credit. Sometimes you genuinely need it reachable
from elsewhere — a remote dev box, a teammate, a cloud agent.

**`SHIM_CLIENT_KEY` is mandatory the moment you do this.** Without it, an
exposed shim is an open proxy to your Gateway account. Set a long random value:

```sh
openssl rand -hex 32
```

```powershell
# Windows PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

Put it in `.env` so every start uses it:

```ini
SHIM_CLIENT_KEY=the_generated_value
```

Cursor then needs that same value in its **OpenAI API Key** field, instead of a
placeholder.

### Expose it

```sh
# macOS
brew install cloudflared
```

```sh
# Linux (.deb / .rpm — see Cloudflare's docs for other distros)
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

```powershell
# Windows
winget install --id Cloudflare.cloudflared
```

A quick tunnel needs no Cloudflare account and prints a public URL:

```sh
cloudflared tunnel --url http://localhost:8787
```

The shim's own tunnel handling is much simpler if you give `cloudflared` its own
config, because a `~/.cloudflared/config.yml` with an ingress list silently
overrides the `--url` flag and will return `404` for every request:

```sh
printf 'metrics: 127.0.0.1:20241\n' > /tmp/cf-quick.yml
cloudflared tunnel --config /tmp/cf-quick.yml --url http://localhost:8787
```

It prints a URL like `https://something-something.trycloudflare.com`. Point
Cursor's base URL at `https://that-host/v1` and set the API key to your
`SHIM_CLIENT_KEY`.

Then confirm the gate is actually closed — this should return `401`, not `200`:

```sh
curl -o /dev/null -w '%{http_code}\n' https://that-host/v1/models
```

```powershell
(Invoke-WebRequest https://that-host/v1/models -SkipHttpErrorCheck).StatusCode
```

Two caveats on quick tunnels:

- **The URL is temporary.** It is regenerated whenever `cloudflared` restarts, so
  Cursor's base URL has to be updated to match. For anything long-lived, set up a
  [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  with a stable hostname instead — the next section shows how.
- **Quick tunnels are public.** Anyone who learns the URL can reach the shim.

### Quick tunnels are for experiments only — plan for a permanent one

A quick tunnel is fine for an afternoon of testing, but as a standing setup it
has real limitations:

- **The hostname is random and ephemeral.** `trycloudflare.com` URLs are issued
  per process. Restart `cloudflared`, reboot the machine, or let the process
  die, and the URL is gone — and every client pointed at it breaks until you
  re-copy a new URL into Cursor. If the shim is meant to be *infrastructure*
  (something you rely on daily), a dependency that reshuffles its own address
  is the wrong shape.
- **No ownership, no control.** A quick tunnel is anonymous: no DNS record you
  can inspect, no access policy you can attach, no logs tied to a tunnel you
  own, and Cloudflare can rate-limit or retire the free trycloudflare service
  at any time.
- **Observability is poor.** With no named tunnel there is no per-tunnel
  metrics, no audit trail, and no way to revoke "just this hostname" without
  killing the whole process.
- **It cannot be kept alive cleanly.** A watchdog can restart a dead quick
  tunnel, but the restart *changes the URL* — so auto-recovery and a stable
  client configuration are mutually exclusive on a quick tunnel.

**Recommendation: spend ten minutes setting up a named tunnel on a domain you
own.** The steps, all free on Cloudflare's standard plan:

1. Add your domain to Cloudflare (it becomes a zone; Cloudflare assigns
   nameservers).
2. `cloudflared tunnel login` (pick the domain's zone).
3. `cloudflared tunnel create <name>` — this issues credentials that live in
   `~/.cloudflared/`.
4. `cloudflared tunnel route dns <name> shim.yourdomain.com` — a stable CNAME
   to the tunnel.
5. Write a small config file (`~/.cloudflared/<name>.yml`) binding
   `shim.yourdomain.com` to `http://127.0.0.1:8787`:

   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /Users/YOU/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: shim.yourdomain.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```

6. Run it — ideally as a persistent service so it survives reboots:

   ```sh
   cloudflared tunnel --config ~/.cloudflared/<name>.yml run <name>
   ```

   (On macOS, register it with `launchd` exactly like the shim in the previous
   section; on Linux, a `systemd --user` unit does the same job.)

What you get: the hostname never changes again, the tunnel auto-reconnects to
Cloudflare's edge on failure, you get per-tunnel metrics and logs in the
Cloudflare dashboard, and you can put Cloudflare Access policies in front of
the hostname for defense in depth on top of the shim's own `SHIM_CLIENT_KEY`.

Keep using the quick tunnel while you evaluate; graduate to the named tunnel
the day the shim becomes something you depend on.
  `SHIM_CLIENT_KEY` is what stops them getting further.

## Serving Cursor and Xcode at once

One shim serves both editors simultaneously. That constraint shapes two details,
and both are easy to break by "fixing" one client at the other's expense.

**Paths are matched by suffix, not exactly.** Cursor takes its base URL verbatim,
so `http://localhost:8787/v1` yields `/v1/models`. Xcode's provider field holds a
host with no `/v1` in it and Xcode appends one itself, so the *same* base URL
yields `/v1/v1/models`. Rejecting either spelling would force the two editors
onto different ports, which is why `handle` strips a leading `/v1` (however many
times it repeats) before routing. Doubled inner slashes are collapsed too.

**Requests from this machine are exempt from the key.** This is what lets Xcode
talk to the shim at all. Xcode's local provider mode offers nowhere to put a
token, and requiring one would make the two editors mutually exclusive on a
single port.

Loopback alone cannot establish "from this machine", because **a Cloudflare
tunnel dials the shim over loopback** — a request from the public internet
arrives from `127.0.0.1`. It does not look local by *header*: cloudflared always
adds `cf-ray` and friends, and an outsider cannot forge those, because the origin
has no inbound port. The only way in is the tunnel, which adds them. Address plus
the absence of proxy headers is therefore a reliable local signal.

Verified against one running shim:

| Request | Key sent | Result |
| --- | --- | --- |
| `GET /v1/v1/models` (Xcode, local) | no | `200` |
| `POST /v1/v1/chat/completions` (Xcode, local) | no | `200` |
| `POST /v1/chat/completions` (tunnelled) | valid | `200` |
| `POST /v1/chat/completions` (tunnelled) | none or wrong | `401` |
| `POST /v1/chat/completions` (local, forged `x-forwarded-for`) | none | `401` |

That last row is the one that matters: you cannot fake being local to skip the
gate.

## Setting up Xcode

Xcode's chat provider is configured independently of Cursor, and the two use
different provider *modes*, which is the source of the path doubling described
above.

**Before anything else**, confirm **Apple Intelligence** is enabled in
**System Settings → Apple Intelligence & Siri**. Xcode cannot use any provider
without it, and the failure is silent otherwise.

Then in Xcode:

1. **Settings → Intelligence → Add a Chat Provider**
2. Choose **Locally Hosted**
3. Fill in only two fields:

| Field | Value |
| --- | --- |
| **Port** | `8787` (or whatever `SHIM_PORT` you set) |
| **Description** | `Merge Gateway` (optional) |

That is the whole form. **Locally Hosted takes only a port** — no URL, no key —
and Xcode builds `http://localhost:8787` itself before appending `/v1/models` and
`/v1/chat/completions`. This is why the shim binds `localhost` rather than
`127.0.0.1`: Xcode offers no host field, and macOS resolves `localhost` to `::1`
(IPv6) first, so an IPv4-only listener is unreachable from Xcode even though
`curl` works.

4. Pick a model from the picker, e.g. `zai/glm-5.3-flash`

If the picker is empty or errors, **quit and reopen Xcode** — it caches the model
list per provider, so a provider added while the shim was down can stay broken
until restart.

Note that listing models works even in capture mode, since it is free and spends
nothing — but **chat only reaches Gateway once `SHIM_PASSTHROUGH=1`**. A shim left
in the default capture mode will populate Xcode's picker and then answer chat
messages with canned text, which reads as "the model is broken" rather than "the
shim is not forwarding".

### Internet Hosted instead

If you would rather point Xcode at Gateway directly for comparison, **Internet
Hosted** accepts a URL and a key:

| Field | Value |
| --- | --- |
| **URL** | `https://api-gateway.merge.dev` — **no `/v1`**, Xcode appends it |
| **Header** | `Authorization` |
| **Key** | your Gateway key, as-is — *not* prefixed with `Bearer` |

This bypasses the shim, so none of the response translation applies. It is useful
for confirming whether a problem is the shim or the provider.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERGE_GATEWAY_API_KEY` | — | Gateway key. Required for passthrough |
| `MERGE_GATEWAY_BASE_URL` | `https://api-gateway.merge.dev/v1/openai` | Gateway's OpenAI surface |
| `MERGE_GATEWAY_PROJECT_ID` | — | Sent as `X-Merge-Project-Id` to attribute cost and apply that project's routing policy |
| `SHIM_HOST` | `localhost` | Bind address. `localhost` binds **both** loopback stacks (IPv4 and IPv6), unlike `127.0.0.1` |
| `SHIM_PORT` | `8787` | Listen port |
| `SHIM_MODEL` | — | Fallback model id when Cursor sends none |
| `SHIM_CAPTURE_DIR` | `captures` | Where captures are written |
| `SHIM_CAPTURE` | `1` | Write captures to disk |
| `SHIM_PASSTHROUGH` | `0` | Forward to Gateway |
| `SHIM_FILTER_MODELS` | `1` | Offer only models that support tool calling |
| `SHIM_TOOL_REASONING_OFF` | `1` | Disable reasoning on tool-result turns for providers that reject them (DeepSeek) |
| `SHIM_CLIENT_KEY` | — | Require this bearer token inbound, on every path that can spend Gateway credit |
| `SHIM_MAX_BODY_BYTES` | `67108864` | Request body cap (or `SHIM_MAX_BODY_MB`) |
| `SHIM_QUIET` | `0` | Suppress per-request lines |
| `SHIM_DEBUG` | — | Verbose translation diagnostics |

Run `node dist/index.js --help` for the flag equivalents. **`--no-env`** skips
`.env` entirely and uses only the shell environment, which is useful for
isolating a run from local configuration — note that the file is read straight
off disk, so clearing shell variables is not enough to escape it.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | The endpoint Cursor and Xcode use |
| `GET` | `/v1/models` | Model list, filtered to tool-capable models |
| `GET` | `/health` | Liveness, and which mode is active |
| `POST` | `/v1/responses` | Responses in, Responses out — for clients that take that path |

## Response translation

Gateway answers `/v1/chat/completions` at `https://api-gateway.merge.dev` with
valid OpenAI, but not the flavour Cursor's Agent loop parses. Pointed straight
at Gateway the UI sat on *Planning next moves* then *Reconnecting* forever, with
no error, while the identical agent flow against Ollama Cloud's OpenAI interface
worked.

**Ollama Cloud is the reference implementation here**, precisely because it
works, and the shim normalises Gateway's frames to match. Captured side by side
for the same request:

| | Ollama Cloud (works) | Gateway (looped) |
| --- | --- | --- |
| Reasoning field | `delta.reasoning` | `delta.thinking` |
| Content | `"content":""` | `"content":null` |
| Absent fields | omitted | `tool_calls`, `annotations`, `thinking_signature` as explicit `null` |
| Extra keys | — | `guardrails`, `routing`, `warnings` |
| Frames per turn | ~10 | ~14, mostly no-op |

The load-bearing difference is the first row. **Cursor renders `delta.reasoning`
and ignores `delta.thinking`**, so every reasoning frame Gateway sent was
discarded and the model appeared to be doing nothing at all. Measured on a live
`zai/glm-5.3-flash` request: raw Gateway emitted 13 `thinking` frames and 0
`reasoning` frames; through the shim the same request emitted 8 reasoning
frames carrying 110 characters of real reasoning, with no `thinking` left.

`reshape.ts` performs the rewrite frame by frame as the stream passes, so
`relayResponse` no longer pipes the body blindly. It also drops frames that
carry nothing usable, which collapses a turn to roughly Ollama's frame count,
and restores the requested model id — Gateway answers with the bare provider id
(`glm-5.3-flash`) where the client asked for the routed one
(`zai/glm-5.3-flash`). Key order is set to Ollama's byte-for-byte so a client
diffing raw frames sees no spurious change.

Errors are never reshaped: a 4xx body is Gateway's own wording and is passed
through verbatim so the real message survives.

## Reasoning models and the agent loop

Some providers reject the **second** turn of a tool conversation. DeepSeek's
thinking mode, through Gateway, returns:

```
The `reasoning_content` in the thinking mode must be passed back to the API.
```

It requires the previous turn's reasoning to be echoed back verbatim. Agent
clients — Cursor included — do not preserve that field, so the turn fails, the
client retries the same conversation, and the UI loops on *Planning next moves*
→ *Reconnecting* with no error shown. Pointing a client straight at Gateway
reproduces it exactly, which is the tell that it is provider behaviour and not
the shim.

Measured against Gateway directly:

| Follow-up payload | Result |
| --- | --- |
| nothing added | `400` |
| `reasoning_content: ""` | `400` |
| `reasoning_content: "x"` | `400` |
| **`reasoning_effort: "none"`** | **`200`** |

Sending a fabricated `reasoning_content` does not satisfy the provider, so the
shim sets `reasoning_effort: "none"` instead — but only on a request that
actually returns tool results, and only when the caller has not set
`reasoning_effort` itself. A plain chat turn, or a caller with an explicit
reasoning preference, is left untouched, so this cannot silently degrade a
request that would have worked. Disable with `SHIM_TOOL_REASONING_OFF=0`.

The rewrite is **scoped to providers that actually demand the echo** — an
allow-list of known offenders, currently DeepSeek's thinking models. This
matters because the fix is not free: it suppresses reasoning the provider would
otherwise have produced, and in an agent loop nearly every turn returns tool
results. Applying it to every model made reasoning effectively vanish for models
that never needed it. Measured on `zai/glm-5.3-flash`, which answers a tool turn
fine either way and simply had its reasoning stripped; it is now left alone.

An unrecognised model also keeps its reasoning, on the grounds that the two
failure modes are not symmetric: getting it wrong for a model that does not need
the echo costs a suppressed thought, while getting it wrong for one that does
need it is a `400` and a looping agent.

## The model list

`GET /v1/models` is not a plain passthrough. Gateway's OpenAI surface advertises
everything it can route — 273 models — but Cursor's Agent mode and Xcode's chat
both attach `tools` on the very first turn. A model without tool calling answers
that turn and then stalls: it cannot call the tool, so the agent loop has
nowhere to go. Those failures only show up after a request has been billed,
which makes a picker full of them worse than unhelpful.

Capability is not published on the OpenAI surface, so the shim joins the two
catalogues it can reach: Gateway's **native** `/v1/models` decides membership
(per-vendor `capabilities.supports_tool_calling`), and the **OpenAI** surface
supplies the entries, because it is the only one keyed by `id` — the field a
picker parses. On a typical org that is **273 → 33 models**.

Two details worth knowing:

- **A model qualifies if *any* vendor serving it supports tools.** Gateway
  routes across vendors, so one capable vendor is enough, and 26 of the visible
  models are served by more than one.
- **Models gated behind `vendor_access_required` stay in the list, sorted last.**
  They are one dashboard setting from working, and silently dropping every
  Claude model would look like a bug in the shim rather than a Gateway
  permission. They are easy to ignore at the bottom of the picker.

If the capability lookup fails, the shim serves the **unfiltered** list and
warns. A wrongly-filtered list hides models that are fine, whereas a long list
merely annoys — so the failure mode is the harmless direction.

Set `SHIM_FILTER_MODELS=0` (or `--no-model-filter`) for the raw 273.

### Context limits

Each entry also carries `context_length` and `max_output_tokens`:

```json
{
  "id": "zai/glm-5.3-flash",
  "object": "model",
  "created": 0,
  "owned_by": "zai",
  "context_length": 1000000,
  "max_output_tokens": 131000
}
```

Two non-standard fields. OpenAI's schema has nowhere to put a context window,
so a client that does not know them ignores them — Cursor and Xcode both read
only `id` today, so this costs nothing and is there for a client that does look.
The name `context_length` matches Ollama's own native `/api/tags` field and the
model metadata Ollama Cloud documents, so a client already parsing that name
from Ollama works unchanged.

**This is a deliberate divergence from Ollama, not conformance to it.** Ollama
Cloud publishes no context field on any endpoint — not its OpenAI-compatible
`/v1/models`, not its native `/api/tags`. All 20 of its cloud models return only
`families`, `family`, `format`, `parameter_size`, `parent_model`, and
`quantization_level` in `details`. The 1M/262K figures its picker displays are
hardcoded in the Ollama binary (`cmd/launch/models.go`), not served over the API.
Gateway publishes real per-vendor windows, so the shim can be strictly more
informative than the thing it is modelled on.

#### Why the advertised number is the **minimum** across vendors

Gateway routes across vendors per request, and vendors disagree. Of the 222
tool-capable models, **47 publish different windows on different vendors**:

| Model | Vendors | Advertised |
| --- | --- | --- |
| `anthropic/claude-sonnet-4-6` | `anthropic` 1,000,000 · `bedrock` 200,000 | **200,000** |
| `zai/glm-5.3-flash` | `baseten` 1,048,576 · seven others 1,000,000 | **1,000,000** |
| `deepseek/deepseek-v4-pro-0423` | `fireworks` 1,048,576 · `tera` 131,072 | **131,072** |

Advertising the maximum would promise a window that a routed request may not
have, and the failure is the one Ollama Cloud already exhibits: an over-long
prompt is accepted and then hard-fails upstream with
`The prompt is too long: …, model maximum context length: …`. Under-promising
only means a client compacts slightly early, which is recoverable. A vendor
publishing `null` or `0` is treated as publishing nothing, so a missing window
never wins the minimum.

A model with no published window omits both fields entirely and renders exactly
as it did before this existed.

## How the translation works

`src/translate.ts`, all pure and synchronous:

| Responses | Chat Completions |
| --- | --- |
| `input[]` | `messages[]` |
| `instructions` | leading `system` message |
| `function_call` / `function_call_output` | `assistant.tool_calls` / `role:"tool"` |
| `{"type":"function","name":…}` | `{"type":"function","function":{…}}` |
| `{"type":"custom","name":"ApplyPatch",…}` | free-form function with a single `input` string |
| `role:"developer"` | `role:"system"` |
| `reasoning:{effort}` | `reasoning_effort` |
| `text:{format}` | `response_format` |
| `max_output_tokens` | `max_tokens` |
| `store`, `include`, `truncation`, `previous_response_id`, `prompt_cache_retention`, `stream_options` | dropped |

Already-nested tools and clean Chat Completions bodies pass through untouched, so
the shim works whether or not Cursor is in its confused mode, and translating
twice changes nothing.

**One deliberate lossy step:** `type:"custom"` tools carry a free-form `format`
(often a grammar) with no Chat Completions equivalent. They are promoted to a
function taking a single free-form `input` string. That keeps the tool callable
instead of rejected — which is what unblocks file edits — but if that payload
does not survive, the fix is a small amount of per-tool mapping in
`convertTools`. The capture from step 1 tells you whether it is needed.

## Tests

```sh
npm test
```

172 checks, no network and no API key required:

- `scripts/translate-check.mjs` — 33 assertions over translation, idempotence,
  and edge cases (string input, images, `developer` role, reasoning-only items,
  unsupported tools, null content)
- `scripts/model-filter-check.mjs` — 41 assertions over catalogue filtering:
  tool-capability membership, multi-vendor qualification, the access-gated flag,
  ordering, graceful degradation on malformed payloads, and the context-limit
  rules (minimum across vendors, `null`/`0` treated as absent, fields omitted
  rather than zeroed)
- `scripts/response-check.mjs` — 29 assertions over response translation: the
  `thinking` → `reasoning` rename, null-to-empty content, gateway-only key
  stripping, no-op frame dropping, tool-call preservation, and the
  non-streaming path
- `scripts/smoke.mjs` — 33 assertions against a live server: boots on an
  ephemeral port, posts each payload shape Cursor is known to send, and checks
  classification, SSE output, error paths, and capture redaction

## Layout

```
src/index.ts      CLI, argument parsing, --check
src/config.ts     env loading and precedence, redaction
src/shape.ts      dialect detection
src/translate.ts  Responses → Chat Completions
src/reshape.ts    Gateway responses → the dialect Cursor parses
src/catalog.ts    model-catalogue filtering by capability
src/upstream.ts   forwarding to Gateway
src/capture.ts    capture writing
src/reply.ts      canned replies for capture mode
src/server.ts     HTTP routing
```

## Security notes

- The shim forwards your Gateway key, so it binds loopback-only by default.
  Binding `SHIM_HOST` elsewhere exposes the key; `--check` warns if you do.
- **Tunnelling is the same exposure by another route**, and it is the case people
  actually hit. `SHIM_CLIENT_KEY` is required for it, and there is no way to
  tunnel without setting it and still be safe — an exposed shim without it
  forwards any caller's requests to Gateway on your key. See
  [Reaching it from another machine](#reaching-it-from-another-machine-cloudflare-tunnel).
- Credentials are redacted before anything touches disk.
- `.env` and `captures/` are gitignored.
- The `.env` parser is not a shell — no interpolation, no command substitution —
  so a malformed file cannot run code.

## Relationship to `ollama-acp`

The streaming and tool-call-reassembly logic here mirrors the Merge Gateway
provider in the sibling `ollama-acp` project (an ACP coding agent for Xcode),
which already talks to the same Gateway surface. That project is a stdio agent;
this one is a server, which is why it is a separate repository rather than a new
entry point there.

## Limitations

- Capture mode answers with a canned message. It verifies the protocol and lets
  Cursor proceed, but it is not a model.
- Non-streaming capture replies are also canned.
- The model filter trusts Gateway's per-vendor `supports_tool_calling` flag. A
  model that advertises tool support but handles it unreliably will still be
  offered.
- Reasoning models may require the client to echo their `reasoning_content` back
  on the following turn. DeepSeek's thinking models reject the request without
  it (`invalid_request_error`), and that comes from the provider rather than the
  shim. Non-reasoning models in the filtered list are unaffected. Reasoning that
  a provider *does* return is now surfaced to the client as `reasoning` rather
  than dropped — see [Response translation](#response-translation).
- `SHIM_TOOL_REASONING_OFF` works around that by disabling reasoning, which is a
  real loss on a model whose whole value is reasoning. It now fires only for
  providers that actually require the echo (see
  [Reasoning models and the agent loop](#reasoning-models-and-the-agent-loop)),
  so a model that tolerates reasoning through a tool conversation keeps it. The
  allow-list is a hardcoded match on the model id and will not recognise a new
  offending provider until it is added; `SHIM_TOOL_REASONING_OFF=0` disables the
  rewrite entirely if a model is wrongly caught by it.

## License

MIT — see [LICENSE](LICENSE).
