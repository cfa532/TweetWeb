# Public Deep-Link Web Routing Implementation Plan

Updated: 2026-07-30

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make public `dtweet.com` browser fallbacks select publicly reachable provider routes instead of Chrome-blocked Tailscale routes.

**Architecture:** Serve browser fallback HTML and static files from the `dtweet-deeplink` Worker's `ASSETS` binding, while TweetWeb resolves volatile provider and node addresses at runtime. Public origins reject private/RFC6598 routes before health checks and check every remaining public route; private origins retain direct Tailscale access. dTweet web gateway domains are never accepted as provider nodes or persisted in `NodePool`. Writable-host and synchronization behavior remain unchanged.

**Tech Stack:** TypeScript, Pinia, Vitest, Vue 3

## Global Constraints

- Keep `dtweet.com` and `www.dtweet.com` as app-link Worker custom domains and
  keep `dl.dtweet.com/*` on the same Worker's browser-fallback route.
- Treat the Worker's bundled `TweetWeb/dist` and the Leither package published
  from gen8 as separate deployment targets.
- Never point Cloudflare DNS or an Origin Rule at a currently resolved gen8 or
  provider IP; those addresses are volatile and belong to runtime resolution.
- Do not change object ownership, root/access-node semantics, normal read APIs, or explicit recovery APIs.
- Do not change writable-host resolution or mutation routing.
- Keep the runtime change limited to read-route eligibility, read connection
  setup, and removal of stale web-gateway cache entries. Tests may be authored,
  but must not be run unless the user explicitly asks.

---

### Task 1: Browser-safe provider route selection

**Files:**
- Create: `src/utils/browserNetwork.ts`
- Create: `src/utils/browserNetwork.test.ts`
- Modify: `src/stores/tweetStore.ts:2515-2605`
- Create: `src/stores/tweetStore.providerRouting.test.ts`

**Interfaces:**
- Produces: `isPrivateBrowserHost(address: string): boolean`
- Produces: `browserUsableProviderRoutes(addresses: string[], originHostname: string): string[]`
- Consumes: raw provider `host:port` strings returned by `get_provider_ips`

- [x] **Step 1: Write pure-helper tests**

Create tests asserting that a public `dl.dtweet.com` origin removes RFC1918 and RFC6598/Tailscale routes while keeping later public IPv4 routes, and that a Tailscale origin retains Tailscale routes. Include bracketed private IPv6 and IPv4-with-port cases.

- [x] **Step 2: Defer the focused helper test unless explicitly requested**

Do not run tests without an explicit user request.

- [x] **Step 3: Implement the minimal pure helper**

Parse raw host, host:port, URL, and bracketed IPv6 forms. Classify loopback, link-local, RFC1918, RFC6598, unique-local IPv6, `.local`, and `.ts.net` as private. Filter private targets only when the page origin is public.

- [x] **Step 4: Reject web gateway hosts in every read context**

Reject `dtweet.com`, `www.dtweet.com`, and `dl.dtweet.com` as provider routes
even when TweetWeb is embedded or opened through a legacy Leither hostname.

- [x] **Step 5: Sanitize the shared node cache**

Remove gateway domains while loading persisted entries, reading cached routes,
and adding or updating nodes. Delete a cached entry when no usable route
remains.

- [x] **Step 6: Remove public-gateway short circuits**

Do not return `window.location.host` from provider or node resolution. Health
checks, read connections, and node-scoped media URLs must use the resolved
route rather than the web gateway.

- [x] **Step 7: Integrate the helper into provider and node read resolution**

Import `browserUsableProviderRoutes`, apply it after v4/empty normalization,
remove the raw first-two truncation, and health-check every browser-usable
public candidate. Revalidate cached routes before reuse. If a normal provider
lookup returns only unusable routes, retry once with `refresh=true`. Leave
`resolveWritableHostIp`, mutation routing, and explicit recovery APIs
unchanged.

- [x] **Step 8: Perform static review**

Inspect the complete diff and confirm writable-host, mutation, ownership, and
recovery code is untouched. Test execution is deferred unless the user
explicitly requests it.

- [x] **Step 9: Publish both release targets**

Publish the current package from `/home/pi/demo/tweet1` with
`/home/pi/demo/tweet1.sh`. Then deploy
`../Tweet-iOS/cloudflare/dtweet-worker` so its `ASSETS` binding receives the
same `TweetWeb/dist`.

- [x] **Step 10: Review and commit**

Review the diff for mutation, root/access-node, and recovery callers. Commit
the routing helper, cache cleanup, read-resolution integration, focused tests,
and updated deep-link documents.
