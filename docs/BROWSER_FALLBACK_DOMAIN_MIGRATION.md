# Browser Fallback Domain Migration Memo

Use this memo when replacing the HTTP Leither domain used by browsers that
open a `dtweet.com` deep link without the native app.

The user registers the new domain and configures DNS to point the root and
all subdomains to av1. After DNS is ready, perform these steps in order:

1. Configure nginx on av1 to route the new domain to Leither.
2. Bind the release app to `t1.<new-domain>` with `Leither mimei setdomain`,
   run on av1 from the Leither root directory.
3. Update and deploy the Cloudflare Worker browser redirect.
4. Update `upgradeDomain` in `TweetBackendApp/go/file_entries.go` and publish
   the File-capable Go backend to both `tweet1` and `twbe` on gen8.

The current completed migration is:

```text
http://t1.ghrwwregas.site  ->  http://t1.w333.space
```

The September 15 migration switched the default browser and share domain;
existing domain routes were preserved. See the completion record below.

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
- `fireshare.us`, `fireshare.uk`, `inoku.uk`, and their subdomains remain
  unchanged. `inoku.uk` serves LifeDrive and must not be retired.

The hash is required before `tweet` and `author`. It selects the TweetWeb route
after Leither loads the application. The fallback must remain HTTP because the
Leither service and its WebSocket providers do not support HTTPS consistently.

## Systems and Source Files

| Area | Location |
| --- | --- |
| Cloudflare Worker | `../Tweet-iOS/cloudflare/dtweet-worker/src/index.js` |
| Worker routes and assets | `../Tweet-iOS/cloudflare/dtweet-worker/wrangler.toml` |
| Go backend share-domain default (release and debug) | `../TweetBackendApp/go/file_entries.go` |
| Go release/debug deployment | `/home/pi/demo/tweet1/` and `/home/pi/demo/twbe/` on gen8 |
| iOS deep-link behavior | `../Tweet-iOS/DEEPLINKING.md` |
| av1 nginx site | `/etc/nginx/sites-available/leither-fireshare` |
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

The active file is `/etc/nginx/sites-available/leither-fireshare`. Make a dated
backup before editing it.

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
current av1 configuration, `registry.inoku.uk` has its own exact server block,
and the `inoku.uk` family also serves LifeDrive through Leither. Preserve both.

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

Both release and debug now use the File-capable Go backend. Historical migration
records below describe the deployments at those dates; their JavaScript release
instructions are superseded by this procedure as of September 13, 2026.

The backend returns the share domain through `check_upgrade`. Update
`upgradeDomain` in `../TweetBackendApp/go/file_entries.go`, without a scheme:

```go
const upgradeDomain = "t1.<new-domain>"
```

This value must agree with the Worker's `BROWSER_FALLBACK_ORIGIN`, which includes
`http://`. Follow [the backend publication procedure](DEPLOYMENT.md#2-publish-backend-changes-first-when-applicable)
to copy the same production Go source into both existing gen8 packages and run
`tweet1.sh` and `twbe.sh`. Preserve public web and download assets. Do not copy
legacy `check_upgrade.js` into either package.

A domain-only migration does not require rebuilding TweetWeb. Verify both
numbered and `last` versions return the new domain and retain dual-format
`health` support before considering the backend publication complete.

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

Verify the new and retired Leither hosts:

```bash
curl -I http://t1.<new-domain>/
curl -I http://t1.<old-domain>/tweet/example-tweet/example-author
curl -I http://<old-domain>/author/example-author
curl -I https://<new-domain>/
curl -I https://t1.<new-domain>/
```

The retired `t1` host must redirect to the new `t1` host. The retired root
must redirect to the new root. Tweet and author redirects must contain the
hash marker. Each HTTPS response must use a valid certificate, return
`Strict-Transport-Security: max-age=0`, and redirect to the same HTTP host.

Finally, confirm that Fireshare was not captured by the migration:

```bash
curl -I http://tweet.fireshare.us/
curl -I http://tweet.fireshare.uk/
```

Neither response may have a `Location` under the new browser domain.

Test one production tweet and one author link on a physical device with the
app installed, then in a browser without app handling. The app should open for
the first case; the browser should land on the HTTP `t1` host for the second.

## Rollback

1. Set `BROWSER_FALLBACK_ORIGIN` back to `http://t1.<old-domain>` and deploy
   the Worker again.
2. Restore the dated av1 nginx backup only if nginx behavior must also be
   rolled back; run `nginx -t` before reloading.
3. Keep the new DNS records during diagnosis unless they are themselves the
   cause. Removing DNS first makes the failure harder to inspect.
4. Keep the Cloudflare zone Redirect Rule disabled throughout rollback.

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
  and `creationFormat: "database"`, matching the current canonical sync contract.
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

The live av1 configuration is
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
