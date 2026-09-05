# Browser Fallback Domain Migration Memo

Use this memo when replacing the HTTP Leither domain used by browsers that
open a `dtweet.com` deep link without the native app.

The current completed migration is:

```text
http://t1.w3w3.store  ->  http://t1.w333w.site
```

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
- Retired domains redirect to the equivalent new host, preserving the
  subdomain, route, and query string.
- `fireshare.us`, `fireshare.uk`, and their subdomains remain unchanged.

The hash is required before `tweet` and `author`. It selects the TweetWeb route
after Leither loads the application. The fallback must remain HTTP because the
Leither service and its WebSocket providers do not support HTTPS consistently.

## Systems and Source Files

| Area | Location |
| --- | --- |
| Cloudflare Worker | `../Tweet-iOS/cloudflare/dtweet-worker/src/index.js` |
| Worker routes and assets | `../Tweet-iOS/cloudflare/dtweet-worker/wrangler.toml` |
| JavaScript backend share-domain default | `../TweetBackendApp/check_upgrade.js` |
| Go backend share-domain default | `../TweetBackendApp/go/file_entries.go` |
| Go backend publication details | `../TweetBackendApp/go/README.md` |
| iOS deep-link behavior | `../Tweet-iOS/DEEPLINKING.md` |
| av1 nginx site | `/etc/nginx/sites-available/leither-fireshare` |
| Full web publication procedure | `TweetWeb/docs/DEPLOYMENT.md` |

The Cloudflare Worker, not a zone-level Redirect Rule, owns the browser
fallback. This is necessary because the Worker must serve the app association
files before deciding whether an ordinary request is a browser navigation.

## 1. Prepare DNS and HTTP Access

Add the new domain to Cloudflare and point both the root and wildcard records
at av1:

```text
<new-domain>
*.<new-domain>
```

Confirm that port 80 remains usable. Do not enable a rule that always upgrades
the fallback host to HTTPS. Test the bare application host, not an
`index.js` URL:

```bash
curl -I http://t1.<new-domain>/
```

The expected result is a Leither response, normally `200 OK`.

## 2. Update av1 nginx

The active file is `/etc/nginx/sites-available/leither-fireshare`. Make a dated
backup before editing it.

The configuration has three separate responsibilities:

1. Preserve the Fireshare host families and proxy them to `127.0.0.1:4801`.
2. Redirect retired root domains and their subdomains to the new domain.
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

Add every retired root to the legacy root `server_name` list. Root requests
redirect to `http://<new-domain>`. The separate regex server for legacy
subdomains must redirect `<subdomain>.<old-domain>` to
`<subdomain>.<new-domain>`.

For `/tweet/*` and `/author/*`, use `/#tweet/*` and `/#author/*` in the
destination. For other routes, preserve `$request_uri` unchanged.

Never replace these blocks with a broad catch-all server. A catch-all can send
native-client hosts such as `tweet.fireshare.us` to the browser domain and
break app routing. It can also capture unrelated exact services. In the
current av1 configuration, `registry.inoku.uk` has its own exact server block
and must remain available even though generic `inoku.uk` Leither hosts retire.

Validate before reloading:

```bash
ssh root@av1 'nginx -t'
ssh root@av1 'systemctl reload nginx'
```

If validation fails, do not reload. Correct the file or restore the dated
backup first.

## 3. Change the Worker and Backend Domain Values

### Worker browser fallback

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

### Backend share-domain defaults

The backend returns a domain to clients through `check_upgrade`; clients use it
when constructing share and deep-link URLs. Update both implementations to the
same new host, without a URL scheme:

```javascript
// ../TweetBackendApp/check_upgrade.js
domain: "t1.<new-domain>"
```

```go
// ../TweetBackendApp/go/file_entries.go
upgradeDomain = "t1.<new-domain>"
```

These values and the Worker's `BROWSER_FALLBACK_ORIGIN` are one operational
setting with three source locations. Never update only one implementation.
The Worker constant includes `http://`; the backend values do not.

## 4. Deploy in the Correct Order

A domain-only migration does not require rebuilding TweetWeb, but it does
require publishing both backend defaults and the Worker. First copy and
hash-check `check_upgrade.js`, then publish the existing `tweet1` package:

```bash
scp ../TweetBackendApp/check_upgrade.js gen8:/home/pi/demo/tweet1/
ssh gen8 'cd /home/pi/demo/tweet1 && shasum -a 256 check_upgrade.js'
ssh gen8 'cd /home/pi/demo && ./tweet1.sh'
```

Next copy the Go MApp sources and publish `twbe` using the canonical commands
in `../TweetBackendApp/go/README.md`. At minimum, compare the changed
`file_entries.go` hash before running the publisher:

```bash
rsync -av -e 'ssh -p 220' \
  --exclude='*_test.go' --include='*.go' --exclude='*' \
  ../TweetBackendApp/go/ pi@gen8.leither.uk:/home/pi/demo/twbe/
ssh -p 220 pi@gen8.leither.uk \
  'shasum -a 256 /home/pi/demo/twbe/file_entries.go'
ssh -p 220 pi@gen8.leither.uk 'cd /home/pi/demo && ./twbe.sh'
```

Finally deploy the Worker. Because `dist` did not change, Wrangler should not
upload assets:

```bash
cd ../Tweet-iOS/cloudflare/dtweet-worker
npx wrangler deploy
```

Wrangler should report that no asset files need uploading and should print a
new Worker version with these routes:

- `dtweet.com`
- `www.dtweet.com`
- `dl.dtweet.com/*`

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

Confirm that both published `check_upgrade` implementations return
`t1.<new-domain>`. A successful Worker redirect alone is insufficient: a
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

## Completed `w333w.site` Migration

Applied on September 2, 2026. The current production state is:

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
Those backend changes still require publication to their respective gen8 app
directories: `check_upgrade.js` through `/home/pi/demo/tweet1.sh`, and the Go
MApp through `/home/pi/demo/twbe.sh`. Resolve gen8 through
`gen8.leither.uk`; never pin its volatile IP. The nginx and Worker migration
does not publish either backend package.
