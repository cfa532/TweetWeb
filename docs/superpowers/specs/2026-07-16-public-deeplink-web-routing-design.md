# Public Deep-Link Web Routing Design

## Goal

Make `dtweet.com` links open the native app when installed and otherwise open
the corresponding TweetWeb page for any public-internet browser, without
requiring Tailscale membership.

## Current Failure

`dtweet.com` correctly redirects browser navigation to the HTTP-only web host
at `dl.dtweet.com`. TweetWeb then resolves provider addresses and health-checks
only the first two candidates. Since a July 7 change, Tailscale addresses in
`100.64.0.0/10` are treated as public candidates. Chrome blocks requests from
the public, insecure `dl.dtweet.com` origin to those more-private addresses via
Private Network Access before the requests reach Tailscale. Public provider
addresses later in the response are therefore never tried.

## Chosen Design

Keep the existing domain boundary:

- `dtweet.com` remains the Universal Link / Android App Link domain and serves
  the Apple and Android association files over HTTPS.
- Browser navigations continue to redirect to
  `http://dl.dtweet.com/<path-and-query>` because TweetWeb and provider RPCs are
  currently HTTP-only.

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

## Error Handling

- Empty or malformed addresses are excluded before health checks. From a
  public origin, private and browser-blocked addresses are excluded as well.
- A failed public candidate does not prevent later public candidates from
  being checked.
- When all usable public candidates fail, existing route-unavailable and cache
  fallback behavior remains unchanged.

## Testing

Add focused unit coverage for the pure classification/ranking behavior:

- a public `dl.dtweet.com` origin rejects Tailscale and RFC 1918 candidates;
- a Tailscale/private origin permits Tailscale candidates;
- public candidates later in the response remain eligible and are preferred;
- IPv4-with-port and bracketed IPv6 parsing remain correct.

Then run the focused unit tests, the complete unit suite, type checking, and a
production build. After deployment, verify the reported `/author/<id>` URL in
a browser and confirm no Tailscale Private Network Access request is attempted
from `dl.dtweet.com`.
