# Public Deep-Link Web Routing Design

Updated: 2026-07-30

## Goal

Make `dtweet.com` links open the native app when installed and otherwise open
the corresponding TweetWeb page for any public-internet browser, without
requiring Tailscale membership.

## Deployed Domain Boundary

- `dtweet.com` and `www.dtweet.com` are Cloudflare Worker custom domains. The
  Worker serves the iOS and Android association files so installed apps can
  claim supported deep links.
- Browser fallback traffic is sent to `dl.dtweet.com` with the original path
  and query.
- `dl.dtweet.com/*` is a route on the same `dtweet-deeplink` Worker. Its
  `ASSETS` binding packages `TweetWeb/dist`, so HTML navigations and the listed
  static assets are served at Cloudflare's edge.
- Non-navigation requests that must reach Leither are proxied to the existing
  HTTP origin.

The Worker source and route configuration live at
`../Tweet-iOS/cloudflare/dtweet-worker`. Its `wrangler.toml` reads assets
directly from `../../../TweetWeb/dist`.

The proxied `dl.dtweet.com` DNS record is an entry/origin address. It is not a
provider-node address and must not be changed to gen8's current public IP.
Provider and node IPs are volatile and are resolved at runtime through
`get_provider_ips` and `get_node_ips`.

## Failure Modes Addressed

Two independent stale-routing failures can make a deep link appear to run old
code or load no tweet:

1. The Cloudflare Worker deployment can contain an older `TweetWeb/dist`.
   Publishing the Leither app on gen8 does not update the Worker's `ASSETS`
   binding; the Worker must also be deployed.
2. A dTweet web gateway hostname such as `dl.dtweet.com` can leak into provider
   metadata or the persisted `NodePool`. Treating that gateway as a provider
   short-circuits volatile-IP resolution and repeatedly sends tweet RPCs back
   to the web entry host.

Public pages must also reject RFC 1918 and RFC 6598/Tailscale candidates before
health checks. Otherwise Chrome can block those requests through Private
Network Access before a later public provider address is attempted.

## Chosen Design

Keep the existing domain boundary:

- `dtweet.com` remains the Universal Link / Android App Link domain and serves
  the Apple and Android association files over HTTPS.
- Browser navigations continue to use `dl.dtweet.com/<path-and-query>`, with
  the Worker serving the built web application and proxying the HTTP-only
  Leither requests it owns.
- Cloudflare DNS remains independent of volatile provider-node addresses.

Centralize browser-route classification in a small pure helper. When TweetWeb
is loaded from a public hostname, the helper classifies RFC 6598
`100.64.0.0/10` routes as browser-blocked alongside RFC 1918 and local IPv6
routes. When TweetWeb itself is loaded from a private or Tailscale origin, the
helper permits Tailscale routes so direct tailnet deployments retain their
current behavior.

Provider and node resolution will filter browser-blocked candidates before
applying any concurrency limit. It will evaluate all usable public candidates
rather than truncating the raw response first. The first healthy public route
still wins, preserving the existing health-check and node-pool behavior.

dTweet web gateway hostnames are never provider candidates, regardless of the
page origin. They are removed from fresh resolver responses and persisted
`NodePool` entries. Normal provider and node reads must therefore perform
runtime resolution instead of replacing the result with `window.location`.

## Data and Synchronization Invariants

This change affects transport-route eligibility only. It does not change:

- user, tweet, comment, or reply ownership;
- root-node versus access-node selection;
- normal `get_*` reads;
- explicit `resync_user` or `refresh_tweet` recovery behavior;
- writable-host resolution or mutation routing.

If a node exposes no browser-usable public route, TweetWeb will retain its
existing unavailable result instead of attempting requests Chrome will block.
A centralized provider gateway is explicitly outside this fix.

## Alternatives Rejected

1. **Serve TweetWeb directly at `dtweet.com`.** The HTTPS app-link domain would
   turn the existing HTTP provider calls into mixed content. Removing `dl`
   therefore requires a broader HTTPS or same-origin gateway migration.
2. **Proxy arbitrary provider addresses through nginx or the Worker.** This
   introduces a public SSRF/open-proxy boundary and centralizes provider
   traffic. It requires a separately designed authenticated gateway.
3. **Make `dl.dtweet.com` tailnet-only.** This violates the requirement that
   shared deep links work for any browser.
4. **Point `dl.dtweet.com` at gen8's current public IP.** gen8's address is
   volatile. Hard-coding it in Cloudflare bypasses runtime node resolution and
   fails after the address changes.

## Error Handling

- Empty or malformed addresses are excluded before health checks. From a
  public origin, private and browser-blocked addresses are excluded as well.
- dTweet web gateway hostnames are removed from resolver results and cached
  node records.
- A failed public candidate does not prevent later public candidates from
  being checked.
- If a non-refresh lookup returns only unusable routes, provider resolution
  retries once with `refresh=true` so the backend can bypass its address cache.
- When all usable public candidates fail, existing route-unavailable and cache
  fallback behavior remains unchanged.

## Deployment

A web release has two distinct publication targets:

1. Build `TweetWeb/dist`.
2. Copy the built package into `/home/pi/demo/tweet1` on gen8 and run
   `/home/pi/demo/tweet1.sh` to publish the Leither app.
3. From `../Tweet-iOS/cloudflare/dtweet-worker`, run `npx wrangler deploy`.
   This uploads the same `TweetWeb/dist` into the Worker's `ASSETS` binding.

Publishing only on gen8 leaves Cloudflare serving the previous bundled assets.
Deploying only the Worker leaves Leither nodes on the previous package.

Do not replace the `dl.dtweet.com` DNS record with a currently resolved gen8 or
provider IP, and do not add a fixed Cloudflare origin-port rule for that node.

## Verification

- Confirm the active Worker deployment is current and still has the
  `dl.dtweet.com/*`, `dtweet.com`, and `www.dtweet.com` triggers.
- Compare the SHA-256 of public `dl.dtweet.com/index_entry.js` with
  `TweetWeb/dist/index_entry.js`; query-string cache busting alone is not proof
  when an edge cache ignores the query.
- Open a reported `/tweet/<tweet-id>/<author-id>` link and confirm the browser
  receives the new bundle.
- Confirm logs show a runtime `get_provider_ips` or `get_node_ips` result and
  never race `dl.dtweet.com` as a provider.
- Confirm no Tailscale Private Network Access request is attempted from the
  public web origin.

Focused unit coverage must continue to assert:

- a public `dl.dtweet.com` origin rejects Tailscale and RFC 1918 candidates;
- a Tailscale/private origin permits Tailscale candidates;
- public candidates later in the response remain eligible and are preferred;
- dTweet web gateway hostnames are never accepted or persisted as provider
  routes;
- IPv4-with-port and bracketed IPv6 parsing remain correct.
