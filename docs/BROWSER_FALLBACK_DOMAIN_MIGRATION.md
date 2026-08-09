# Browser Fallback Domain Migration Memo

Use this memo when replacing the HTTP Leither domain used by browsers that
open a `dtweet.com` deep link without the native app.

The completed example was:

```text
http://t1.www3.shop  ->  http://t1.w3w3.store
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
break app routing.

Validate before reloading:

```bash
ssh root@av1 'nginx -t'
ssh root@av1 'systemctl reload nginx'
```

If validation fails, do not reload. Correct the file or restore the dated
backup first.

## 3. Change the Worker Fallback

In `../Tweet-iOS/cloudflare/dtweet-worker/src/index.js`, change only the
browser fallback constant:

```javascript
const BROWSER_FALLBACK_ORIGIN = "http://t1.<new-domain>";
```

Do not change `ORIGIN`; `http://dl.dtweet.com` is the Worker origin for
non-navigation requests. Do not replace the app-link routes: the canonical
profile route is `/author/*`, not `/user/*` or `/profile/*`.

The Worker already converts browser routes to the required hash form. Keep the
route match restricted to `tweet` and `author`.

In the Cloudflare `dtweet.com` zone, the old single Redirect Rule must remain
disabled. It may be renamed to describe the new fallback, but enabling it would
run before the Worker and bypass the association-file handling.

## 4. Deploy in the Correct Order

For a domain-only change, do not rebuild TweetWeb or republish `tweet1` on
gen8. Deploying the Worker is sufficient because the contents of `dist` did
not change:

```bash
cd ../Tweet-iOS/cloudflare/dtweet-worker
npx wrangler deploy
```

Wrangler should report that no asset files need uploading and should print a
new Worker version with these routes:

- `dtweet.com`
- `www.dtweet.com`
- `dl.dtweet.com/*`

If TweetWeb or `TweetBackendApp` also changed, this is no longer a domain-only
operation. Follow the full [publication and deployment procedure](DEPLOYMENT.md):
publish backend changes to gen8 when applicable, build TweetWeb, copy `dist` to
gen8, run `tweet1.sh`, and deploy the Worker last.

## 5. Verify the Migration

Use a real `GET` with an HTML `Accept` header for the Worker checks. A `HEAD`
request does not enter the Worker's browser-navigation branch.

```bash
curl -sS -D - -o /dev/null -H 'Accept: text/html' \
  https://dtweet.com/tweet/example-tweet/example-author

curl -sS -D - -o /dev/null -H 'Accept: text/html' \
  https://dtweet.com/author/example-author
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

Verify the new and retired Leither hosts:

```bash
curl -I http://t1.<new-domain>/
curl -I http://t1.<old-domain>/tweet/example-tweet/example-author
curl -I http://<old-domain>/author/example-author
```

The retired `t1` host must redirect to the new `t1` host. The retired root
must redirect to the new root. Tweet and author redirects must contain the
hash marker.

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

## Completed `w3w3.store` Example

The current production state is:

- Worker fallback: `http://t1.w3w3.store`
- Canonical Leither family: `w3w3.store`, `*.w3w3.store`
- Retired families on av1: `www333.store`, `www3.shop`, `www33.online`, and
  their subdomains
- Deep-link routes: `/tweet/*` and `/author/*`
- Browser routes: `/#tweet/*` and `/#author/*`
- Fireshare families: preserved and proxied without domain replacement
