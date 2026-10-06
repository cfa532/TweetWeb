# TweetWeb Publication and Deployment

This is the canonical production release procedure for TweetWeb. A release is
complete only after the same `dist` build has been published to both targets:

1. the Leither `tweet1` app on gen8; and
2. the `dtweet-deeplink` Cloudflare Worker asset binding.

Publishing only one target leaves the other target serving the previous web
application.

For a browser-domain replacement, use the separate
[Browser Fallback Domain Migration Memo](BROWSER_FALLBACK_DOMAIN_MIGRATION.md).

## Prerequisites

- Run the commands from the `TweetWeb` repository unless a step says otherwise.
- gen8 is always the Leither publication target. Resolve its volatile public IP
  through the Cloudflare-managed `gen8.leither.uk` record; never copy a
  currently resolved IP into scripts, documentation, DNS rules, or `.env`.
- Before connecting, run `nslookup gen8.leither.uk` and set `GEN8_IP` to the
  freshly returned IPv4 address for that session. Connect by that IP with
  `HostKeyAlias=[gen8.leither.uk]:220` to preserve host-key verification:

  ```bash
  nslookup gen8.leither.uk
  GEN8_IP='replace-with-freshly-resolved-IP'
  ssh -p 220 -o 'HostKeyAlias=[gen8.leither.uk]:220' "pi@$GEN8_IP"
  ```

- Ensure Wrangler is authenticated for the `dtweet.com` Cloudflare account.
- Keep the sibling `TweetBackendApp` repository next to `TweetWeb`; backend
  MApp scripts are copied from there when a release includes backend changes.
- Keep the sibling `Tweet-iOS` repository next to `TweetWeb`; the Worker lives
  at `../Tweet-iOS/cloudflare/dtweet-worker` and reads this repository's `dist`
  directory.

Both release (`tweet1`) and debug (`twbe`) must run the File-capable Go backend
from `TweetBackendApp/`. Do not publish the legacy JavaScript backend into
either package: it cannot read `tweet-file-v1` objects.

## 1. Select the Publication Environment

The repository `.env` contains mutually exclusive `RELEASE` and `DEBUG`
sections. Select exactly one before building:

| Publication | `.env` state |
| --- | --- |
| Release | Keep the `RELEASE` variables active. Comment every variable in the `DEBUG` section. |
| Debug | Comment the `RELEASE` variables. Uncomment every variable in the `DEBUG` section. |

For both release and debug publication, comment every
`VITE_LEITHER_NODE` assignment. It is a local testing override and must never
be embedded in a published bundle:

```dotenv
# VITE_LEITHER_NODE=192.168.99.1:8002       # gen8
# VITE_LEITHER_NODE=192.168.99.6:8081       # tahoe
# VITE_LEITHER_NODE=192.168.1.21:8003        # beijing
# VITE_LEITHER_NODE=125.229.161.122:8080    # ksbox
# VITE_LEITHER_NODE=192.168.5.4:8080        # minipc
```

Do not commit an `.env` change made only for publication. Record the original
local state so it can be restored after verification.

### gen8 target directories

Publish each project into its existing application directory on gen8. Do not
replace one whole directory with another project's files:

| Source | gen8 target | Publisher |
| --- | --- | --- |
| TweetWeb release `dist` assets | `/home/pi/demo/tweet1/` | `/home/pi/demo/tweet1.sh` |
| TweetBackendApp production Go sources (release) | `/home/pi/demo/tweet1/` | `/home/pi/demo/tweet1.sh` |
| TweetBackendApp production Go sources (debug) | `/home/pi/demo/twbe/` | `/home/pi/demo/twbe.sh` |

## 2. Publish Backend Changes First (When Applicable)

Pushing or committing `TweetBackendApp` does not update either Leither app.
Production `.go` sources live in the `TweetBackendApp` repository root.
Release and debug can have different published revisions. For a domain-only
change, follow the migration memo and preserve each package’s other code and assets.
Keep the existing app names and directories: they determine the AppIDs.

| Environment | Package | AppID | Publisher |
| --- | --- | --- | --- |
| Release | `/home/pi/demo/tweet1/` | `heWgeGkeBX2gaENbIBS_Iy1mdTS` | `tweet1.sh` |
| Debug | `/home/pi/demo/twbe/` | `d4lRyhABgqOnqY4bURSm_T-4FZ4` | `twbe.sh` |

Back up packages outside their application directories. Copy production Go
sources to the selected package, preserving existing public web/download assets.
Exclude `*_test.go`, `go.mod`, `go.sum`, documentation, local tooling and signing
keys. Remove superseded backend source files from the package after backing them
up; retain browser JavaScript assets such as `hprose.js` and `index_entry.js`.

For example, from TweetWeb, publish the debug backend (use `tweet1` and
`tweet1.sh` for release):

```bash
rsync -av -e 'ssh -p 220 -o HostKeyAlias=[gen8.leither.uk]:220' \
  --exclude='*_test.go' --include='*.go' --exclude='*' \
  ../TweetBackendApp/ "pi@$GEN8_IP:/home/pi/demo/twbe/"
shasum -a 256 ../TweetBackendApp/file_store.go
ssh -p 220 -o 'HostKeyAlias=[gen8.leither.uk]:220' "pi@$GEN8_IP" \
  'shasum -a 256 /home/pi/demo/twbe/file_store.go'
ssh -p 220 -o 'HostKeyAlias=[gen8.leither.uk]:220' "pi@$GEN8_IP" 'cd /home/pi/demo && bash -e ./twbe.sh'
```

Check upload, backup and publication results; the script's final success message
alone is insufficient. Verify `health` by the new numbered version, then `last`:
`storageFormats` must contain both `database` and `tweet-file-v1`, and
creation policy must match the intended package and the
[canonical sync contract](../../TweetBackendApp/docs/LEITHER_DATA_AND_SYNC_CONTRACT.md).
Current full backend releases report `creationFormat: "mixed"` with
`creationFormats` for each object type. A domain-only deployment preserves the
package’s existing policy; the October 6 record documents the release/debug
revision difference. Check the same on serving/root nodes;
synchronize the application MID from gen8 if a node still serves an old package.
Do not republish from those nodes, or synchronize/migrate user data as part of an
application deployment. Never roll back to a database-only reader once File
objects exist.

Complete backend publication before building TweetWeb. When both backend and
web assets change, publish again after copying the generated web files. The Go
runtime details are maintained in `TweetBackendApp/README.md`.

## 3. Build Once

```bash
npm run build
```

This runs the TypeScript check and creates the selected environment's package in `dist`.
When publishing both environments, build each with its own AppID and default
followings, and save their outputs separately. Environment overrides can select
the build without editing `.env`. Keep the release output in `dist` for Wrangler.
Do not rebuild between the two publication targets; both must receive the same
output.

## 4. Publish the Leither App

Copy the generated entry files and static dependencies into the matching
package on gen8: `tweet1` for release, `twbe` for debug. The example below is
release; for debug use its saved output, `/home/pi/demo/twbe/` and `twbe.sh`.
Never overwrite one environment with the other environment's web bundle:

```bash
scp -P 220 -o 'HostKeyAlias=[gen8.leither.uk]:220' \
  dist/bootstrap.min.js \
  dist/gtag.js \
  dist/hprose.js \
  dist/ic_splash.png \
  dist/index.html \
  dist/index_entry.js \
  dist/popper.min.js \
  "pi@$GEN8_IP:/home/pi/demo/tweet1/"
```

Publish the package with the existing server-side script:

```bash
ssh -p 220 -o 'HostKeyAlias=[gen8.leither.uk]:220' "pi@$GEN8_IP" 'cd /home/pi/demo && ./tweet1.sh'
```

The command must finish with `APP published successfully` and report a new
backup/version number.

## 5. Deploy the Cloudflare Worker and Assets (Release Only)

### Why the Worker is required

The `dtweet-deeplink` Worker is both the public deeplink gateway and one of the
two production copies of TweetWeb:

`BROWSER_FALLBACK_ORIGIN` in the Worker source is the source of truth for the
browser application domain. It currently equals `http://t1.ww33.world`, but
that is replaceable operational configuration, not a permanent domain
contract. The av1 section below describes the current routing. Use the
[Browser Fallback Domain Migration Memo](BROWSER_FALLBACK_DOMAIN_MIGRATION.md)
whenever the value changes.

- It serves the Apple and Android association files from `dtweet.com`, allowing
  an installed native app to claim `/tweet/*`, `/author/*`, `#tweet/*`, and
  `#author/*` links before the browser opens them.
- If no installed app claims a normal browser navigation, it redirects the
  route to the HTTP fallback host and converts path routes to hash routes. For
  example, `/author/<id>` becomes
  `http://t1.ww33.world/#author/<id>`. TweetWeb uses HTTP there because the
  Leither service it contacts does not accept HTTPS.
- It terminates HTTPS for `dl.dtweet.com`. Static TweetWeb files are served
  from the Worker's asset binding, browser navigations are redirected to the
  separate HTTP fallback host, and other requests are proxied to the HTTP
  Leither origin. Do not redirect `dl.dtweet.com` back to HTTP on the same
  hostname: browsers such as Chrome can upgrade the URL to HTTPS again and
  create a redirect loop.

The Worker's asset binding is independent of the Leither `tweet1` package on
gen8. Running `tweet1.sh` updates only gen8; it does not update Cloudflare.
Likewise, deploying the Worker updates only Cloudflare; it does not publish the
Leither package. Every TweetWeb release must therefore publish the exact same
`dist` build to both targets.

### How to deploy it

`../Tweet-iOS/cloudflare/dtweet-worker/wrangler.toml` points its `ASSETS`
binding directly at `TweetWeb/dist`. Build once, copy that build to gen8, run
`tweet1.sh`, and then deploy the Worker without rebuilding in between:

```bash
cd ../Tweet-iOS/cloudflare/dtweet-worker
npx wrangler deploy
```

Wrangler compares the current `dist` files with the deployed asset set, uploads
the changed assets, publishes the Worker code, and reports a new Worker version
ID. A successful deployment must list all three production triggers below.
Return to the TweetWeb repository afterward and perform the hash and routing
checks in step 6.

Confirm Wrangler reports a new version and all production routes:

- `dtweet.com`
- `www.dtweet.com`
- `dl.dtweet.com/*`

The `dtweet.com` zone's legacy browser-fallback Redirect Rule must remain
disabled. The Worker owns the
browser redirect after serving the iOS and Android association files. An
active zone redirect runs before the Worker and bypasses that routing logic.

## 6. Verify Production

From the `TweetWeb` repository, compare the local JavaScript bundle with the
legacy Worker asset host:

```bash
shasum -a 256 dist/index_entry.js
curl -fsSL https://dl.dtweet.com/index_entry.js | shasum -a 256
```

Both SHA-256 values must match. If an edge temporarily serves an older
asset, wait for propagation and repeat the direct checks; a query string alone
is not proof that the cached bundle changed.

Do not hash `http://t1.ww33.world/index_entry.js` directly. It is a Leither
domain whose loader generates the app entry response and resolves bare
object names inside the published package; that URL is not a raw static-asset
endpoint. The local-versus-gen8 hash check before `tweet1.sh` verifies the
Leither package input.

Also confirm that both association files return JSON directly from
`https://dtweet.com`, then open both production
`/tweet/<tweet-id>/<author-id>` and `/#tweet/<tweet-id>/<author-id>` URLs. With
the app installed, the operating system should open the app. In a browser, the
Worker must land both forms on
`http://t1.ww33.world/#tweet/<tweet-id>/<author-id>`, and that page must load the
current bundle without mixed-content errors.

### Troubleshooting: `dl.dtweet.com` opens but no data loads

If `https://dl.dtweet.com` returns the TweetWeb shell but profiles and tweets do
not load, inspect the browser console. This incident occurred on September 5,
2026 when the Worker served HTML navigation from its HTTPS asset binding. The
page then tried to open Leither's `ws://` provider endpoints, and the browser
rejected every attempt with `SecurityError: An insecure WebSocket connection
may not be initiated from a page loaded over HTTPS`.

The correct fix is request-class routing in the Worker, not an HTTPS-to-HTTP
redirect on the same `dl.dtweet.com` hostname:

| Request to `dl.dtweet.com` | Required result |
| --- | --- |
| Browser `GET` accepting `text/html` | `302` to the current `BROWSER_FALLBACK_ORIGIN`; `/tweet/*` and `/author/*` become hash routes |
| Listed static asset such as `/index_entry.js` | `200` from the Worker `ASSETS` binding |
| Apple or Android association file | `200` JSON from the Worker |
| Other request | Proxy through Cloudflare to the HTTP Leither origin |

Do not redirect to `http://dl.dtweet.com`: Chrome can upgrade that URL back to
HTTPS and create a loop. Redirect browser navigation to the separate fallback
host. Use real `GET` requests because `HEAD` does not enter the navigation
branch:

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  -H 'Accept: text/html' https://dl.dtweet.com/
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  -H 'Accept: text/html' https://dl.dtweet.com/author/example-author
curl -fsS -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://dl.dtweet.com/index_entry.js
```

Finally, open a fragment-form link in a real browser, such as
`https://dl.dtweet.com/#author/<id>`. Confirm that the final URL retains the
fragment under the configured HTTP fallback and that profile and tweet data
load.

### av1 nginx domain-routing invariant

As verified October 6, 2026, the active site is
`/etc/nginx/sites-enabled/leither-fireshare` on av1. It is a regular file,
not a symlink to the older `sites-available` copy. Inspect `nginx -T` before
editing and save dated backups outside `sites-enabled`.

| Host family | Current behavior to preserve |
| --- | --- |
| `ww33.world`, `*.ww33.world` | Proxy HTTP to Leither at `127.0.0.1:4801` with the original Host header; canonicalize `/tweet/*` and `/author/*` to hash routes. Release app is bound to `t1.ww33.world`. |
| `w33w.site`, `*.w33w.site`, `w333.space`, `*.w333.space` | Retain their existing Leither proxy routes. The October 6 switch did not retire these domains. |
| `w333w.site`, `w3w3.store`, `www333.store`, `www3.shop`, `www33.online`, and their subdomains | Retain existing redirects to corresponding `w33w.site` hosts, preserving subdomain, route, query, and tweet/author hash markers. |
| `fireshare.us`, `*.fireshare.us`, `fireshare.uk`, `*.fireshare.uk` | Proxy to Leither with the original Host header. Do not redirect native-client hosts to a browser domain. |
| `*.lepan.org` | Preserve LifeDrive's Leither proxy and the dedicated exact-host routes for `drive.lepan.org`, `gw.lepan.org`, and `registry.lepan.org`; preserve the separate root site too. |

The canonical HTTPS block uses `/etc/letsencrypt/live/ww33.world/` and covers
`ww33.world`, `www.ww33.world`, `t1.ww33.world`, and `tweet.ww33.world`.
It sends `Strict-Transport-Security: max-age=0` and redirects to the same HTTP
host and request URI. The HTTP page is required for the app's HTTP and `ws://`
providers. Renewal uses `/var/www/letsencrypt` and the enabled `certbot.timer`.

After an nginx edit, validate before reloading and check the affected routes:

```bash
ssh root@av1 'nginx -t && systemctl reload nginx'
curl -I http://t1.ww33.world/
curl -I http://t1.ww33.world/tweet/example/author
curl -I https://ww33.world/
curl -I https://t1.ww33.world/
curl -I http://t1.w33w.site/
curl -I http://tweet.fireshare.us/
curl -I http://tweet.fireshare.uk/
curl -I http://drive.lepan.org/
curl http://registry.lepan.org/health
```

The new `t1` host must serve the release app; its tweet route must redirect
with `/#tweet/`. HTTPS must present a valid certificate, clear HSTS, and return
to HTTP. Existing browser and Fireshare hosts must retain their routes, and
LifeDrive and registry checks must reach their respective services.

See the [October 6 migration record](BROWSER_FALLBACK_DOMAIN_MIGRATION.md#completed-ww33world-default-domain-switch)
for published versions, backups, asset hash, and verification limits. Older
migration records describe historical configurations and must not be reapplied
over the current routes.

## 7. Restore Local Testing Configuration

After verification, restore the developer's original `.env` value when local
testing requires a fixed node:

```dotenv
VITE_LEITHER_NODE=192.168.99.1:8002       #gen8
```

Restoring `.env` does not alter already-built or deployed assets.

## Publication Checklist

- [ ] Exactly one `.env` section is active: `RELEASE` for a release build or
      `DEBUG` for a debug build.
- [ ] Every `VITE_LEITHER_NODE` assignment is commented for both build types.
- [ ] gen8 DNS was freshly resolved and its returned IP used with the required
      `HostKeyAlias`; no volatile IP was saved as permanent configuration.
- [ ] Backend packages retain the intended File-capable Go revisions;
      no legacy JavaScript backend was introduced.
- [ ] Changed Go files were hash-checked and published from the correct gen8
      package with its existing publisher script.
- [ ] Numbered and `last` health responses advertise both storage formats on
      gen8 and serving/root nodes; File tweet and comment reads succeed.
- [ ] `npm run build` completed successfully.
- [ ] The seven generated assets were copied to gen8.
- [ ] `tweet1.sh` published a new Leither app version.
- [ ] Wrangler deployed a new Worker version with all three routes.
- [ ] The legacy browser-fallback zone rule is disabled.
- [ ] Public asset hashes match `dist/index_entry.js`.
- [ ] Association files return JSON and a browser tweet link redirects to
      `http://t1.ww33.world` and loads successfully.
- [ ] av1 serves `t1.ww33.world` and preserves existing browser-domain redirects,
      Fireshare hosts, and LifeDrive/registry routes under `lepan.org`.
- [ ] The developer's original local `.env` value was restored.

## Operational Incident: av1 Memory Exhaustion (2026-09-19)

All times below are UTC+8. `http://t1.fireshare.us/` stopped responding;
av1 was unreachable over HTTP, public SSH, and its Tailscale address. The
Leither backend on gen8 still returned HTTP 200 when queried locally with
`Host: t1.fireshare.us`. The user rebooted av1 at approximately 20:52, restoring
SSH and public HTTP service.

### Evidence and cause

Previous-boot records in `/var/log/kern.log`, `/var/log/syslog`, the systemd
journal, and `/var/log/sysstat/sa19` showed severe memory pressure:

- At 16:19, Linux killed `fwupd` for memory exhaustion.
- At 17:21, the scheduled `fwupd-refresh.service` started the firmware updater
  again. Memory-pressure warnings followed at 17:22.
- At 19:20, the one-minute load average reached 122.65 on two CPUs. Linux
  killed the root user-session systemd process and `fwupd`; journald and
  snapd hit watchdog timeouts. The previous boot's logs ended at 19:20:43.
- Earlier out-of-memory events had killed Leither on September 14–18, so this
  was a recurring capacity problem rather than an isolated web release failure.

av1 had 894 MiB of usable RAM and an active 4 GiB swap file. Kernel dumps and
historical metrics showed that all swap remained unused during the failures.
`/etc/sysctl.conf` explicitly set `vm.swappiness = 0`; the active TuneD
`virtual-guest` profile specified 30, but TuneD's `reapply_sysctl = 1` reapplied
the conflicting system override afterward. `/etc/sysctl.d/99-sysctl.conf`
was a symlink to `/etc/sysctl.conf`. The inspected service cgroups did not
restrict swap.

Memory exhaustion is confirmed; the firmware refresh appears to have triggered
the final episode. Zero swappiness strongly delays swapping rather than
disabling it outright; see the
[kernel swappiness documentation](https://kernel.org/doc/html/latest/admin-guide/sysctl/vm.html#swappiness).
The logs do not establish an application memory leak.

### Resolution and verification

At 21:31, the following correction was applied on av1:

1. Backed up `/etc/sysctl.conf` to
   `/root/sysctl.conf.before-swappiness.GgnUhq`.
2. Removed only the `vm.swappiness = 0` line from `/etc/sysctl.conf`.
3. Applied `sysctl -w vm.swappiness=30` for the running system. The enabled
   TuneD service and its existing `virtual-guest` profile provide the persistent
   setting; no additional override was added.

At 21:32, the live value was still 30, `tuned`, `nginx`, and `leither` were
active, and both the local nginx route and the public URL returned HTTP 200.
No additional reboot, application deployment, or firmware-service change was
needed. These checks confirm the configuration and immediate availability;
long-term recurrence prevention and persistence across a later reboot have
not yet been observed.

For a subsequent read-only check:

```bash
ssh root@av1 'sysctl vm.swappiness; cat /etc/tuned/active_profile; systemctl is-enabled tuned; systemctl is-active tuned nginx leither; free -h'
curl -I --max-time 20 http://t1.fireshare.us/
```

Expected: swappiness 30, profile `virtual-guest`, TuneD enabled, all three
services active, and HTTP 200. Swap need not be used while memory is available.
If memory exhaustion recurs, inspect new kernel events and per-process memory
before choosing further changes; the host still has less than 1 GiB of RAM.
