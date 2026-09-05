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
- Ensure `ssh -p 220 pi@gen8.leither.uk` and
  `scp -P 220 ... pi@gen8.leither.uk:...` work.
- Ensure Wrangler is authenticated for the `dtweet.com` Cloudflare account.
- Keep the sibling `TweetBackendApp` repository next to `TweetWeb`; backend
  MApp scripts are copied from there when a release includes backend changes.
- Keep the sibling `Tweet-iOS` repository next to `TweetWeb`; the Worker lives
  at `../Tweet-iOS/cloudflare/dtweet-worker` and reads this repository's `dist`
  directory.

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
| TweetWeb `dist` assets | `/home/pi/demo/tweet1/` | `/home/pi/demo/tweet1.sh` |
| TweetBackendApp JavaScript entries used by the release app | `/home/pi/demo/tweet1/` | `/home/pi/demo/tweet1.sh` |
| TweetBackendApp Go debug MApp sources | `/home/pi/demo/twbe/` | `/home/pi/demo/twbe.sh` |

## 2. Publish Backend Changes First (When Applicable)

Pushing or committing `TweetBackendApp` does not update the Leither app. If the
release includes changed backend MApp JavaScript, copy the committed versions
of those files into the existing `tweet1` package before building or deploying
TweetWeb. Copy only the changed backend files; do not replace the whole
`tweet1` directory because it also contains production web assets and release
artifacts.

For example, repeat the source-file argument for every changed backend entry:

```bash
scp -P 220 \
  ../TweetBackendApp/changed-entry-1.js \
  ../TweetBackendApp/changed-entry-2.js \
  pi@gen8.leither.uk:/home/pi/demo/tweet1/
```

Compare the local and remote file hashes, then publish the backend changes:

```bash
shasum -a 256 ../TweetBackendApp/changed-entry-1.js
ssh -p 220 pi@gen8.leither.uk \
  'shasum -a 256 /home/pi/demo/tweet1/changed-entry-1.js'
ssh -p 220 pi@gen8.leither.uk 'cd /home/pi/demo && ./tweet1.sh'
```

The command must finish with `APP published successfully`. Complete this
backend publication before continuing with the TweetWeb build. When the same
release changes both projects, `tweet1.sh` is therefore run twice: once after
copying backend scripts and again after copying the web `dist` files.

For a debug Go-backend publication, copy the production `.go` source files
from `TweetBackendApp/go/` into `/home/pi/demo/twbe/`, preserving the directory
name `twbe`, then run `/home/pi/demo/twbe.sh`. Do not copy `*_test.go`, `go.mod`,
`go.sum`, or `README.md` into the MApp package. The complete TWBE procedure is
maintained in `TweetBackendApp/go/README.md`.

## 3. Build Once

```bash
npm run build
```

This runs the TypeScript check and creates the production package in `dist`.
Do not rebuild between the two publication targets; both must receive the same
output.

## 4. Publish the Leither App

Copy the generated entry files and static dependencies into the `tweet1`
package on gen8:

```bash
scp -P 220 \
  dist/bootstrap.min.js \
  dist/gtag.js \
  dist/hprose.js \
  dist/ic_splash.png \
  dist/index.html \
  dist/index_entry.js \
  dist/popper.min.js \
  pi@gen8.leither.uk:/home/pi/demo/tweet1/
```

Publish the package with the existing server-side script:

```bash
ssh -p 220 pi@gen8.leither.uk 'cd /home/pi/demo && ./tweet1.sh'
```

The command must finish with `APP published successfully` and report a new
backup/version number.

## 5. Deploy the Cloudflare Worker and Assets

### Why the Worker is required

The `dtweet-deeplink` Worker is both the public deeplink gateway and one of the
two production copies of TweetWeb:

`BROWSER_FALLBACK_ORIGIN` in the Worker source is the source of truth for the
browser application domain. It currently equals `http://t1.w333w.site`, but
that is replaceable operational configuration, not a permanent domain
contract. Treat concrete `w333w.site` URLs in this guide as the current
deployment snapshot. Use the
[Browser Fallback Domain Migration Memo](BROWSER_FALLBACK_DOMAIN_MIGRATION.md)
whenever the value changes.

- It serves the Apple and Android association files from `dtweet.com`, allowing
  an installed native app to claim `/tweet/*`, `/author/*`, `#tweet/*`, and
  `#author/*` links before the browser opens them.
- If no installed app claims a normal browser navigation, it redirects the
  route to the HTTP fallback host and converts path routes to hash routes. For
  example, `/author/<id>` becomes
  `http://t1.w333w.site/#author/<id>`. TweetWeb uses HTTP there because the
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

Do not hash `http://t1.w333w.site/index_entry.js` directly. It is a Leither
domain whose loader generates the app entry response and resolves bare
object names inside the published package; that URL is not a raw static-asset
endpoint. The local-versus-gen8 hash check before `tweet1.sh` verifies the
Leither package input.

Also confirm that both association files return JSON directly from
`https://dtweet.com`, then open both production
`/tweet/<tweet-id>/<author-id>` and `/#tweet/<tweet-id>/<author-id>` URLs. With
the app installed, the operating system should open the app. In a browser, the
Worker must land both forms on
`http://t1.w333w.site/#tweet/<tweet-id>/<author-id>`, and that page must load the
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

The active site is `/etc/nginx/sites-available/leither-fireshare` on `av1`
(enabled through `sites-enabled`). Preserve these host-family boundaries:

The September 2, 2026 `w333w.site` migration was applied to this file after
creating the backup
`/etc/nginx/sites-available/leither-fireshare.pre-w333w-20260902-0842`.
Keep dated backups for future migrations; do not overwrite this known-good
pre-migration copy.

| Host family | Required behavior |
| --- | --- |
| `fireshare.us`, `*.fireshare.us` | Proxy to Leither at `127.0.0.1:4801` with the original `Host` header. Never redirect to `w333w.site`. |
| `fireshare.uk`, `*.fireshare.uk` | Proxy to Leither at `127.0.0.1:4801` with the original `Host` header. Never redirect to `w333w.site`. |
| `w3w3.store`, `www333.store`, `www3.shop`, `www33.online`, generic `inoku.uk`, and their subdomains | Redirect to the equivalent `w333w.site` host; preserve the route, query, and subdomain. Canonicalize external `/tweet/*` and `/author/*` paths with `/#`. |
| `registry.inoku.uk` | Preserve the dedicated registry service; its exact nginx block takes precedence over the generic retired-domain regex. |
| `w333w.site`, `*.w333w.site` | Proxy to Leither; canonicalize external `/tweet/*` and `/author/*` paths with `/#`. |

The canonical browser hosts also have a dedicated port-443 downgrade block.
It uses the Let's Encrypt certificate at
`/etc/letsencrypt/live/w333w.site/`, sends
`Strict-Transport-Security: max-age=0`, and redirects HTTPS back to the same
HTTP host and request URI. This prevents Chrome's HTTPS upgrade from falling
through to an unrelated TLS virtual host while keeping Leither and its
providers on HTTP. The certificate currently covers the root, `www`, `t1`,
and `tweet` hosts; Certbot renewal is managed by `certbot.timer`.

The Fireshare domains are still used by native clients. Redirecting a host such
as `tweet.fireshare.us` to `tweet.w333w.site` changes the app-link host and can
prevent the native app from opening. An ordinary TweetWeb release must not
replace the Fireshare proxy block with a catch-all legacy-domain redirect.

After any nginx edit, validate and reload on `av1`, then check the canonical,
Fireshare, and retired host families:

```bash
ssh root@av1 'nginx -t'
ssh root@av1 'systemctl reload nginx'
curl -I http://tweet.fireshare.us/
curl -I http://tweet.fireshare.uk/
curl -I http://w333w.site/
curl -I https://w333w.site/
curl -I https://t1.w333w.site/
curl -I http://t1.w3w3.store/tweet/example/author
curl -I http://t1.www333.store/tweet/example/author
curl -I http://t1.www3.shop/tweet/example/author
curl -I --resolve t1.www33.online:80:47.245.61.67 http://t1.www33.online/tweet/example/author
curl -I http://tweet.inoku.uk/author/example
curl http://registry.inoku.uk/health
```

The Fireshare roots must not return a `Location` under `w333w.site`;
`w333w.site` must reach Leither, and each retired host must redirect to the
matching `w333w.site` host. `registry.inoku.uk` must continue to reach its
dedicated service. `--resolve` is required for `www33.online` until
that retired domain has public DNS pointing at av1. The two canonical HTTPS
checks must present a valid certificate, clear HSTS with `max-age=0`, and
redirect to the equivalent HTTP URL.

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
- [ ] gen8 was addressed through `gen8.leither.uk`, not a pinned IP.
- [ ] If `TweetBackendApp` changed, its committed JavaScript files were copied,
      hash-checked, and published from `/home/pi/demo/tweet1/` on gen8 before
      the TweetWeb build.
- [ ] If the Go debug backend changed, its production `.go` files were copied
      to `/home/pi/demo/twbe/` and published with `twbe.sh` on gen8.
- [ ] `npm run build` completed successfully.
- [ ] The seven generated assets were copied to gen8.
- [ ] `tweet1.sh` published a new Leither app version.
- [ ] Wrangler deployed a new Worker version with all three routes.
- [ ] The legacy browser-fallback zone rule is disabled.
- [ ] Public asset hashes match `dist/index_entry.js`.
- [ ] Association files return JSON and a browser tweet link redirects to
      `http://t1.w333w.site` and loads successfully.
- [ ] av1 preserves `fireshare.us` and `fireshare.uk` hosts while redirecting
      the retired `w3w3.store`, `www333.store`, `www3.shop`, `www33.online`,
      and generic `inoku.uk` families to `w333w.site`, while preserving the
      exact `registry.inoku.uk` service.
- [ ] The developer's original local `.env` value was restored.
