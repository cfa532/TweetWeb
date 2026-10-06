# Browser Fallback Domain Migration Memo

Use this memo when replacing the HTTP Leither domain used by browsers that
open a `dtweet.com` deep link without the native app.

The user registers the new domain and configures DNS to point the root and
all subdomains to av1. After DNS is ready, perform these steps in order:

1. Configure nginx on av1 to route the new domain to Leither.
2. Bind the release app to `t1.<new-domain>` with `Leither mimei setdomain`,
   run on av1 from the Leither root directory.
3. Update and deploy the Cloudflare Worker browser redirect.
4. Update `upgradeDomain` in `TweetBackendApp/file_entries.go` and publish
   the File-capable Go backend to both `tweet1` and `twbe` on gen8.

The current completed migration is:

```text
http://t1.w33w.site  ->  http://t1.ww33.world
```

The October 6 migration switched the default browser and share domain;
existing domain routes were preserved. See the
[October 6 completion record](#completed-ww33world-default-domain-switch).
Historical records below describe the configuration at their recorded dates.

The same procedure applies to another retired family such as `www33.shop`.
Add every spelling that has actually been used to the legacy nginx host list;
do not assume that `www3.shop`, `www33.shop`, `www333.store`, and
`www33.online` are interchangeable DNS names.

## Required Result

- `dtweet.com` remains the HTTPS app-link domain.
- The Apple and Android association files remain on `https://dtweet.com` and
  return JSON without a redirect.
- An installed app claims the supported `/tweet/*` and `/author/*` links.
- A browser navigation redirects to the new HTTP `t1` host with a hash route:

```text
https://dtweet.com/tweet/<tweet-id>/<author-id>
  -> http://t1.<new-domain>/#tweet/<tweet-id>/<author-id>

https://dtweet.com/author/<author-id>
  -> http://t1.<new-domain>/#author/<author-id>
```

- The new root domain and all its subdomains reach Leither on av1.
- HTTPS requests for the canonical browser hosts use a valid certificate,
  clear any cached HSTS policy, and redirect back to the same HTTP URL.
- If retiring existing domains, redirect them to the equivalent new host,
  preserving the subdomain, route, and query string. A default-domain switch
  alone can leave existing domain routes in place.
- Fireshare and LifeDrive routing remains unchanged. As of October 6, the
  live LifeDrive family is `lepan.org`, with dedicated `drive`, `gw`, and
  `registry` hosts. Inspect the active nginx configuration; do not restore the
  historical `inoku.uk` configuration from an older migration record.

The hash is required before `tweet` and `author`. It selects the TweetWeb route
after Leither loads the application. The fallback must remain HTTP because the
Leither service and its WebSocket providers do not support HTTPS consistently.

## Systems and Source Files

| Area | Location |
| --- | --- |
| Cloudflare Worker | `../Tweet-iOS/cloudflare/dtweet-worker/src/index.js` |
| Worker routes and assets | `../Tweet-iOS/cloudflare/dtweet-worker/wrangler.toml` |
| Go backend share-domain default (release and debug) | `../TweetBackendApp/file_entries.go` |
| Go release/debug deployment | `/home/pi/demo/tweet1/` and `/home/pi/demo/twbe/` on gen8 |
| iOS deep-link behavior | `../Tweet-iOS/DEEPLINKING.md` |
| av1 nginx site | `/etc/nginx/sites-enabled/leither-fireshare` |
| Full web publication procedure | `TweetWeb/docs/DEPLOYMENT.md` |

The Cloudflare Worker, not a zone-level Redirect Rule, owns the browser
fallback. This is necessary because the Worker must serve the app association
files before deciding whether an ordinary request is a browser navigation.

## Prerequisite: User Prepares DNS

Add the new domain to Cloudflare and point both the root and wildcard records
at av1:

```text
<new-domain>
*.<new-domain>
```

Confirm that port 80 remains usable. Do not enable a rule that always upgrades
the fallback host to HTTPS. After nginx configuration and app domain binding,
check the bare application host, not an
`index.js` URL:

```bash
curl -I http://t1.<new-domain>/
```

The expected result is a Leither response, normally `200 OK`.

## 1. Update av1 nginx

The active file is `/etc/nginx/sites-enabled/leither-fireshare`. As of October 6,
2026 it is a regular file, not a symlink to `sites-available`; inspect `nginx -T`
before editing. Save dated backups outside `sites-enabled` so nginx does not
load them as additional sites.

The configuration has three separate responsibilities:

1. Preserve the Fireshare host families and proxy them to `127.0.0.1:4801`.
2. Preserve existing domain routes unless their retirement is requested.
3. Proxy the new root domain and wildcard subdomains to Leither while
   preserving the original `Host` header.

Chrome can upgrade an explicitly entered HTTP URL before making the request.
If the canonical host falls through to another TLS virtual host, that site can
return an unrelated page or install an HSTS policy for the Leither domain. Add
a dedicated HTTPS server for the canonical browser hosts. It must use a
publicly trusted certificate, clear HSTS, and return to HTTP without changing
the host, route, or query:

```nginx
server {
    listen 443 ssl;
    server_name <new-domain> www.<new-domain> t1.<new-domain> tweet.<new-domain>;

    ssl_certificate /etc/letsencrypt/live/<new-domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<new-domain>/privkey.pem;

    add_header Strict-Transport-Security "max-age=0" always;
    return 302 http://$host$request_uri;
}
```

Serve `/.well-known/acme-challenge/` from a local webroot in the canonical
port-80 block so certificate renewal does not depend on Leither. Do not proxy
the HTTPS request to Leither: TweetWeb still needs an HTTP page in order to use
the HTTP and `ws://` provider endpoints without mixed-content blocking.

For the new canonical family, the essential server block is:

```nginx
server {
    listen 80;
    server_name <new-domain> *.<new-domain>;

    location ~ ^/(tweet|author)(/.*)$ {
        return 302 http://$host/#$1$2$is_args$args;
    }

    location / {
        proxy_pass http://127.0.0.1:4801;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

When retiring a domain, add every retired root to the legacy root `server_name` list. Root requests
redirect to `http://<new-domain>`. The separate regex server for legacy
subdomains must redirect `<subdomain>.<old-domain>` to
`<subdomain>.<new-domain>`.

For `/tweet/*` and `/author/*`, use `/#tweet/*` and `/#author/*` in the
destination. For other routes, preserve `$request_uri` unchanged.

Never replace these blocks with a broad catch-all server. A catch-all can send
native-client hosts such as `tweet.fireshare.us` to the browser domain and
break app routing. It can also capture unrelated exact services. In the
current av1 configuration, `registry.lepan.org`, `drive.lepan.org`, and
`gw.lepan.org` have dedicated routes alongside the `*.lepan.org` Leither
proxy and the root site. Preserve these routes.

Validate before reloading:

```bash
ssh root@av1 'nginx -t'
ssh root@av1 'systemctl reload nginx'
```

If validation fails, do not reload. Correct the file or restore the dated
backup first.

## 2. Bind the Release App Domain

On av1, from the Leither root directory, run:

```bash
./Leither mimei setdomain --mid <appMid> t1.<new-domain>
```

The installed CLI on av1 uses lowercase `setdomain` and the `--mid` flag.
Its Leither root directory is `/root/demo`.

Replace `<appMid>` with the release application's actual MID. Use the hostname
without a URL scheme. This binds the release app to the new hostname; DNS and
nginx routing alone do not perform this binding. Confirm the new hostname
loads the release app before switching the Worker redirect.

## 3. Update and Deploy the Worker Browser Fallback

In `../Tweet-iOS/cloudflare/dtweet-worker/src/index.js`, change only the
browser fallback constant:

```javascript
const BROWSER_FALLBACK_ORIGIN = "http://t1.<new-domain>";
```

Do not change `ORIGIN`; `http://dl.dtweet.com` is the Worker origin for
non-navigation requests. Do not replace the app-link routes: the canonical
profile route is `/author/*`, not `/user/*` or `/profile/*`.

The Worker already converts browser routes to the required hash form. Keep the
route match restricted to `tweet` and `author`. Browser HTML navigation on
`dl.dtweet.com` must use the same fallback redirect. Serving the TweetWeb shell
there under HTTPS makes its `ws://` Leither connections fail as mixed content.
Static assets, association files, and non-navigation proxy requests must remain
on their existing Worker branches.

In the Cloudflare `dtweet.com` zone, the old single Redirect Rule must remain
disabled. It may be renamed to describe the new fallback, but enabling it would
run before the Worker and bypass the association-file handling.

Deploy the Worker after the new hostname is bound and serving the release app.
For a domain-only migration, `dist` does not change. Only use the normal
deployment below when local `dist` matches the deployed assets; Wrangler should
not upload assets. Otherwise retain the deployed assets as recorded for
September 12 below.

```bash
cd ../Tweet-iOS/cloudflare/dtweet-worker
npx wrangler deploy
```

Wrangler should report that no asset files need uploading and should print a
new Worker version with these routes:

- `dtweet.com`
- `www.dtweet.com`
- `dl.dtweet.com/*`

## 4. Update and Publish Both Go Backends

Both release and debug use the File-capable Go backend in the repository root.
Historical migration records below describe deployments at those dates. Their
JavaScript release instructions were superseded on September 13, 2026.

The backend returns the share domain through `check_upgrade`. Update
`upgradeDomain` in `../TweetBackendApp/file_entries.go`, without a scheme:

```go
const upgradeDomain = "t1.<new-domain>"
```

This value must agree with the Worker's `BROWSER_FALLBACK_ORIGIN`, which includes
`http://`. Follow [the backend publication procedure](DEPLOYMENT.md#2-publish-backend-changes-first-when-applicable)
to publish changes to the existing gen8 packages with `tweet1.sh` and `twbe.sh`.
For a domain-only migration, compare each package with its published numbered
version, back it up, and change only `upgradeDomain` in each deployed
`file_entries.go`; do not publish unrelated local source differences. Preserve
public web and download assets. Do not copy legacy `check_upgrade.js` into
either package. Before publication, verify the publishing node's local and
network MiMei versions agree. Resolve gen8 freshly and use the required
`HostKeyAlias` as described in the deployment guide.

A domain-only migration does not require rebuilding TweetWeb. Verify both
numbered and `last` versions return the new domain and retain dual-format
`health` support on both gen8 and av1 before considering publication complete.
If av1 still serves an older package, synchronize only the application MID:

```bash
ssh root@av1 'cd /root/demo && ./Leither mimei sync --mid heWgeGkeBX2gaENbIBS_Iy1mdTS && ./Leither mimei sync --mid d4lRyhABgqOnqY4bURSm_T-4FZ4'
```

Recheck numbered and `last` responses afterward. The October 6 migration did
not require restarting Leither. Do not restart routinely or synchronize user
data as part of a domain change.

If TweetWeb has code changes beyond the domain migration, follow the full
[publication and deployment procedure](DEPLOYMENT.md): publish backend changes
first, build TweetWeb, copy `dist` to gen8, run `tweet1.sh`, and deploy the
Worker last. Do not rebuild between the gen8 and Worker publication targets.

## 5. Verify the Migration

Use a real `GET` with an HTML `Accept` header for the Worker checks. A `HEAD`
request does not enter the Worker's browser-navigation branch.

```bash
curl -sS -D - -o /dev/null -H 'Accept: text/html' \
  https://dtweet.com/tweet/example-tweet/example-author

curl -sS -D - -o /dev/null -H 'Accept: text/html' \
  https://dtweet.com/author/example-author

curl -sS -D - -o /dev/null -H 'Accept: text/html' \
  https://dl.dtweet.com/author/example-author

curl -fsS -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://dl.dtweet.com/index_entry.js
```

Expected `Location` values:

```text
http://t1.<new-domain>/#tweet/example-tweet/example-author
http://t1.<new-domain>/#author/example-author
```

Verify that app associations still return JSON directly:

```bash
curl -i https://dtweet.com/.well-known/apple-app-site-association
curl -i https://dtweet.com/.well-known/assetlinks.json
```

Confirm that both published Go backends' `check_upgrade` return
`t1.<new-domain>` for the numbered version and `last`. A successful Worker redirect alone is insufficient: a
client receiving the old backend value can continue producing links for the
retired domain.

Verify the new and existing Leither hosts:

```bash
curl -I http://t1.<new-domain>/
curl -I http://t1.<old-domain>/tweet/example-tweet/example-author
curl -I http://<old-domain>/author/example-author
curl -I https://<new-domain>/
curl -I https://t1.<new-domain>/
```

If retirement was explicitly requested, the retired `t1` host must redirect
to the new `t1` host, and the retired root to the new root. Otherwise preserve
the existing routes, as in the October 6 migration. Tweet and author redirects
must contain the hash marker. Each HTTPS response must use a valid certificate,
return `Strict-Transport-Security: max-age=0`, and redirect to the same HTTP host.

Finally, confirm that Fireshare, LifeDrive, and the registry retain their routes:

```bash
curl -I http://tweet.fireshare.us/
curl -I http://tweet.fireshare.uk/
curl -I http://drive.lepan.org/
curl http://registry.lepan.org/health
```

Fireshare responses must not have a `Location` under the new browser domain.
LifeDrive and registry requests must still reach their respective services.

Test one production tweet and one author link on a physical device with the
app installed, then in a browser without app handling. The app should open for
the first case; the browser should land on the HTTP `t1` host for the second.

## Rollback

1. Set `BROWSER_FALLBACK_ORIGIN` back to `http://t1.<old-domain>` and deploy
   the Worker again.
2. Restore each backend package's previous `upgradeDomain`, then republish and
   verify numbered and `last` responses on gen8 and av1. Use the dated backup
   to identify the previous value; avoid overwriting unrelated later changes.
3. Restore the dated active nginx backup only if routing must also be rolled
   back. Confirm the actual loaded path with `nginx -T`, validate, then reload.
4. Keep new DNS records during diagnosis unless they are themselves the cause.
   Removing DNS first makes the failure harder to inspect.
5. Keep the Cloudflare zone Redirect Rule disabled throughout rollback.

## Completed `ww33.world` Default-Domain Switch

Applied October 6, 2026, in nginx → binding → Worker → Go backend order:

- Root and wildcard DNS resolve to av1 (`47.245.61.67`). The active nginx file
  is `/etc/nginx/sites-enabled/leither-fireshare`, a regular file. The older
  `sites-available` copy is not loaded. The first certificate attempt exposed
  this distinction; the unused file was restored and the active file updated.
- Added HTTP proxying for `ww33.world` and all subdomains, preserving Host and
  canonicalizing external tweet/author paths to hash routes. Existing domain
  routes were preserved, including `w33w.site`, Fireshare, and the current
  LifeDrive/registry hosts under `lepan.org`. No domain was retired.
- The certificate covers `ww33.world`, `www.ww33.world`, `t1.ww33.world`, and
  `tweet.ww33.world`, expires January 4, 2027, and renews through the existing
  enabled Certbot timer. HTTPS clears HSTS and redirects to the same HTTP URL.
- Release MID `heWgeGkeBX2gaENbIBS_Iy1mdTS` is bound to `t1.ww33.world`.
- Worker version `e4ac115b-c396-4d9c-b233-201e3b599ce3` switches only
  `BROWSER_FALLBACK_ORIGIN`, retaining the deployed `ASSETS` binding with the
  metadata method below. All three existing triggers remain active.
- Before publication, gen8's local and network MiMei versions agreed, and all
  package Go files matched their published numbered sources. Only
  `upgradeDomain` changed in each package; other source and web/download assets
  were preserved. Release advanced from `1396` to `1398`; debug from `1659` to
  `1661`. The matching local source is now `TweetBackendApp/file_entries.go`.
- av1 synchronized both application MIDs. Both numbered and `last` responses on
  gen8 and av1 return `t1.ww33.world`. Both retain database and File support.
  Existing release/debug creation-policy differences were preserved; this
  domain migration does not reconcile unrelated backend versions. No service
  restart was required.

Backups:

- Active av1 configuration:
  `/etc/nginx/sites-available/leither-fireshare.active-pre-ww33-world-20261006`
- gen8 packages: `/home/pi/demo/deploy-backups/domain-ww33-world-20261006/`

Live HTTP checks confirmed the app MID on the new host, tweet/author redirects,
valid certificates and HTTPS-to-HTTP behavior for all four certificate names,
JSON app-association responses, and preserved old-browser, Fireshare, LifeDrive,
and registry routes. The Worker `index_entry.js` SHA-256 remained unchanged:
`53271c5700a17112b63a339f74b2aa07b9f68098432b49eacd151d0dbc4e3023`.
No TweetWeb build or automated tests were run. Physical-device app-link handling
was not exercised.

Operational follow-up: the existing publisher emitted signing-key material in
its command output. Key rotation and correction of that logging remain
outstanding; neither was performed as part of this domain migration. Do not
copy the sensitive output into documentation or shared deployment logs.

### Release redeployment later on October 6

- Rebuilt the release app with `npm run build`; the build and TypeScript check
  passed. Release environment settings were already active and all local node
  overrides were commented, so `.env` did not need modification.
- gen8 initially held local version `1396` while the network advertised `1398`;
  its live `last` response had reverted to the old domain. Explicit release-app
  synchronization restored agreement before publication. The cause of that
  stale local view was not diagnosed by this redeployment.
- All production Go source hashes matched the local backend, including
  `upgradeDomain = "t1.ww33.world"`. The release package was backed up to
  `/home/pi/demo/deploy-backups/release-ww33-world-20261006-023118/`, then the
  seven rebuilt web assets were copied and hash-checked before publishing.
- Release version `1400` was published. The debug package was not redeployed.
  The same build was deployed to Worker version
  `8097e92a-b682-4e35-bf6a-f82fe3fc885c` with all three existing triggers.
- After release-app synchronization, gen8 and av1 agreed on local/network
  version `1400`. Both `1400` and `last` returned `domain: "t1.ww33.world"`
  and the expected dual-format health response.
- Bundle SHA-256 matched the local build, gen8 package, av1 published asset,
  and public Worker asset:
  `754d02158a034c30db8b436728bb2f1969f575f49cb2f265a807de199755d067`.
- The publisher output was captured in memory and only known success fields
  and the new version were emitted, avoiding further disclosure of signing
  material. The underlying logging issue remains outstanding.

No automated tests were run. No Leither restart was required.

### Second release redeployment on October 6

- Built again with `npm run build`; build and TypeScript checks passed. No
  automated tests were run and the debug package was not redeployed.
- gen8 again reported local `1396` while the network advertised `1400`.
  Synchronization restored agreement before backup and publication. This
  recurring local-version regression remains unresolved; successful immediate
  checks do not establish that the new local version will persist.
- Backup: `/home/pi/demo/deploy-backups/release-ww33-world-20261006-030117/`.
  Source and asset hashes were checked before publishing release `1402`.
- Worker version: `b6ba4484-39e5-4497-8b59-15234c0b8b58`, with the same release
  build and all three production triggers.
- gen8's local/network versions agreed at `1402` after publication. On gen8
  and av1, both `1402` and `last` returned `domain: "t1.ww33.world"` and the
  expected dual-format health response. No service restart was required.
- The local build, gen8 input, av1 published asset, and public Worker asset
  shared bundle SHA-256
  `872b0f5cb7bb1aa2ba05f367691625a56f377ae8a3d4e7627d71c562c315655e`.
  Browser redirects and association-file responses were verified again.

## Completed `w333.space` Default-Domain Switch

Applied September 15, 2026, in nginx → binding → Worker → Go backend order:

- Root and wildcard DNS resolve to av1. nginx now proxies `w333.space` and
  its subdomains to Leither, preserving the original Host header and converting
  external tweet/author paths to hash routes.
- Existing domain routes, including `ghrwwregas.site`, Fireshare, LifeDrive,
  and the registry, were preserved. No old domain family was retired.
- A publicly trusted certificate covers `w333.space`, `www.w333.space`,
  `t1.w333.space`, and `tweet.w333.space`. HTTPS returns to the same HTTP host
  with `Strict-Transport-Security: max-age=0`; automatic renewal is enabled.
- av1 bound release app `heWgeGkeBX2gaENbIBS_Iy1mdTS` to `t1.w333.space`.
- Worker version `c15bfcce-0608-4251-a754-bdfb47b61139` sets
  `BROWSER_FALLBACK_ORIGIN` to `http://t1.w333.space`. The domain-only deployment
  retained the deployed `ASSETS` binding using the September 12 metadata method.
  All three existing triggers remain active.
- `upgradeDomain` in `TweetBackendApp/go/file_entries.go` now equals
  `t1.w333.space`. Both gen8 packages received the same current production Go
  sources, preserving their existing web/download assets. Release published as
  version `1330`; debug published as `1649`.
- Both numbered and `last` backend calls return the new domain and upgrade
  version `75`. Health reports `storageFormats: ["database", "tweet-file-v1"]`
  and `creationFormat: "database"`, matching the contract at that time.
  The earlier File-creation expectation in deployment documentation is historical.
- av1 initially served the previous debug package, so only that application MID
  was synchronized from gen8. Both numbered versions then returned the new
  domain, but the `last` runtime aliases still executed cached code. Restarting
  `leither.service` cleared that cache; both `last` aliases now return the new
  domain and current health response. Leither returned active and the new host,
  Fireshare, and LifeDrive returned HTTP 200 afterward.

Backups:

- av1: `/etc/nginx/sites-available/leither-fireshare.pre-w333-space-20260915`
- gen8: `/home/pi/demo/deploy-backups/domain-w333-space-20260915/`

Live checks confirmed the release MID at the new hostname, correct Worker
hash routes, valid HTTPS-to-HTTP handling, JSON app-association responses,
and unchanged Fireshare/LifeDrive/registry routing. The Worker's
`index_entry.js` SHA-256 remained unchanged:
`a1a43df4f71c689f10fff6dc782911aaaa86a94011aaf28e9f7b63a913566eb2`.
No TweetWeb build or automated test suite was run. Physical-device app-link
behavior was not exercised during this migration.

The separate `ww33.uk` Cloudflare wildcard rule is a `301` from
`*://*.ww33.uk/*` to `http://${2}.w333.space/${3}`, preserving queries;
it does not include bare `ww33.uk`. The initial HTTPS-only pattern was expanded
to include HTTP after an HTTP tweet link failed to redirect. Both schemes now
redirect, and opening the reported HTTP tweet link in Chrome confirmed that
the complete `#tweet/<tweet-id>/<author-id>` fragment survives the redirect.

## Completed `ghrwwregas.site` Default-Domain Switch

Applied September 12, 2026, in the requested nginx → binding → Worker → backend
order:

- The user configured the root and wildcard DNS records to av1.
- nginx now proxies `ghrwwregas.site` and its subdomains to `127.0.0.1:4801`.
  Existing routes, including `w333w.site`, Fireshare, and LifeDrive, were
  preserved. No old domain family was retired in this switch.
- A public certificate covers the root, `www`, `t1`, and `tweet` hosts.
  HTTPS clears HSTS and redirects to HTTP; Certbot renewal is enabled.
- On av1, from `/root/demo`, the release binding succeeded with:

  ```bash
  ./Leither mimei setdomain --mid heWgeGkeBX2gaENbIBS_Iy1mdTS t1.ghrwwregas.site
  ```

- Worker version `519d483b-ae8b-47d4-8cce-332423fb454a` redirects browser
  navigation to `http://t1.ghrwwregas.site`. The previous version was
  `95fc4eab-26c4-4a1d-acd5-8c413f5aece6`.
- The domain-only Worker deployment used a temporary Wrangler configuration
  with the same entry point and routes, no local `[assets]` upload, and this
  metadata to retain the existing assets and binding:

  ```toml
  [unsafe.metadata]
  keep_assets = true
  bindings = [{ type = "assets", name = "ASSETS" }]
  ```

- Both local backend source defaults were updated. On gen8, only the domain
  value in each deployed file was changed because local sources had unrelated
  unpublished differences. `tweet1.sh` initially published release app version
  `1286`; `twbe.sh` also published Go debug app version `1625`. The user then
  corrected the deployment scope: this flow must deploy the JavaScript release
  source into `<Leither root>/tweet1/`. The Go publication was outside that
  intended flow; the procedure above has been corrected.

Backups:

- av1: `/etc/nginx/sites-available/leither-fireshare.pre-ghrwwregas-20260912`
- gen8: `/home/pi/demo/deploy-backups/domain-ghrwwregas-20260912/`

Live checks confirmed the release app MID at the new hostname, correct Worker
tweet/author redirects, valid HTTPS-to-HTTP handling, direct JSON association
responses, and unchanged Fireshare/LifeDrive responses. The Worker
`index_entry.js` SHA-256 remained
`08f9a63fcf78cefabe9ffeb99d239a9225cc3f1ebd06d896ee6d843950a87c1e`.
The new release `check_upgrade.js` was also visible through av1.

Release version `1286` and its `last` alias returned `t1.ghrwwregas.site`.
Go version `1625` returned the new domain, but its `last` alias initially
continued returning `t1.w3w3.store` despite the new source being visible under
`/mm/<mid>:last/`. With user approval, `leither-demo.service` was restarted on
gen8 to clear the stale runtime. The service returned to active/running, and
both release and Go `check_upgrade` calls using `ver=last` then returned
`t1.ghrwwregas.site`.

After the user's correction, the current `TweetBackendApp/check_upgrade.js`
was copied to `/home/pi/demo/tweet1/` on gen8 and published with `tweet1.sh` as
release app version `1288`. The source-file SHA-256 matched locally, in the
gen8 deployment directory, and through av1's published `:last` source:
`506a4df8fc8d0d1e980a5b17edaa26b781e7e9dc1ea475b0e5b141fe01e1e1a8`.
Live release calls using both `ver=1288` and `ver=last` returned
`domain: "t1.ghrwwregas.site"` and upgrade `version: 74`.

## Historical `w333w.site` Migration

Applied on September 2, 2026. The production state recorded at that time was:

- Worker fallback: `http://t1.w333w.site`
- Canonical Leither family: `w333w.site`, `*.w333w.site`
- Retired families on av1: `w3w3.store`, `www333.store`, `www3.shop`,
  `www33.online`, generic `inoku.uk`, and their subdomains
- Dedicated exception: `registry.inoku.uk` remains on its exact service block
- Deep-link routes: `/tweet/*` and `/author/*`
- Browser routes: `/#tweet/*` and `/#author/*`
- Fireshare families: preserved and proxied without domain replacement

At that time, the live av1 configuration was
`/etc/nginx/sites-available/leither-fireshare`, enabled through
`/etc/nginx/sites-enabled/leither-fireshare`. The pre-migration backup is:

```text
/etc/nginx/sites-available/leither-fireshare.pre-w333w-20260902-0842
```

The HTTPS/HSTS correction has its own pre-change backup:

```text
/etc/nginx/sites-available/leither-fireshare.pre-w333w-https-20260902-0925
```

Let's Encrypt covers `w333w.site`, `www.w333w.site`, `t1.w333w.site`, and
`tweet.w333w.site`. Certbot's systemd timer is enabled for automatic renewal.
If another canonical application subdomain is introduced, add it to both the
certificate and the dedicated port-443 `server_name` list before publishing
links that use it.

`nginx -t` passed before nginx was reloaded. Production verification confirmed:

| Request | Verified result |
| --- | --- |
| `http://w333w.site/` and `http://t1.w333w.site/` | `200 OK` from Leither |
| `https://w333w.site/` and `https://t1.w333w.site/` | Valid TLS, HSTS reset, then `302` to the same HTTP host |
| Retired root and subdomain requests | `302` to the equivalent `w333w.site` host |
| Retired `/tweet/*` and `/author/*` requests | `302` with the required `/#` route marker |
| `http://tweet.fireshare.us/` and `http://tweet.fireshare.uk/` | `200 OK`, without domain replacement |
| `http://registry.inoku.uk/health` | Registry health JSON from its dedicated service |
| Browser navigation to a `dtweet.com/tweet/*` link | `302` to `http://t1.w333w.site/#tweet/*` |
| Apple and Android association endpoints | `200 OK` with JSON, without redirect |

The deployed Cloudflare Worker version for this migration is
`72880739-2a7a-43ab-8837-f3a601260711`.

The backend share-domain defaults have also been changed to `t1.w333w.site`
in `TweetBackendApp/check_upgrade.js` and `TweetBackendApp/go/file_entries.go`.
At that time, those backend changes still required publication to their respective gen8 app
directories: `check_upgrade.js` through `/home/pi/demo/tweet1.sh`, and the Go
MApp through `/home/pi/demo/twbe.sh`. Resolve gen8 through
`gen8.leither.uk`; never pin its volatile IP. The nginx and Worker migration
does not publish either backend package.
