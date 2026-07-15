# Public Deep-Link Web Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make public `dtweet.com` browser fallbacks select publicly reachable provider routes instead of Chrome-blocked Tailscale routes.

**Architecture:** Add a small pure address-classification helper and use it only in TweetWeb's normal provider-read resolver. Public origins reject private/RFC6598 routes before health checks and check every remaining public route; private origins retain direct Tailscale access. Writable-host and synchronization behavior remain unchanged.

**Tech Stack:** TypeScript, Pinia, Vitest, Vue 3

## Global Constraints

- Keep `dtweet.com` redirecting browser loads to the HTTP-only `dl.dtweet.com` web host.
- Do not change object ownership, root/access-node semantics, normal read APIs, or explicit recovery APIs.
- Do not change writable-host resolution or mutation routing.
- Keep the change limited to provider-read route eligibility. Tests may be authored, but must not be run unless the user explicitly asks.

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

- [ ] **Step 1: Write failing pure-helper tests**

Create tests asserting that a public `dl.dtweet.com` origin removes RFC1918 and RFC6598/Tailscale routes while keeping later public IPv4 routes, and that a Tailscale origin retains Tailscale routes. Include bracketed private IPv6 and IPv4-with-port cases.

- [ ] **Step 2: Defer the focused helper test unless explicitly requested**

Do not run tests without an explicit user request.

- [ ] **Step 3: Implement the minimal pure helper**

Parse raw host, host:port, URL, and bracketed IPv6 forms. Classify loopback, link-local, RFC1918, RFC6598, unique-local IPv6, `.local`, and `.ts.net` as private. Filter private targets only when the page origin is public.

- [ ] **Step 4: Defer helper test execution unless explicitly requested**

Do not run tests without an explicit user request.

- [ ] **Step 5: Write a failing store integration test**

Mock `get_provider_ips` to return `100.79.13.15:8002`, `100.89.71.56:8080`, and `220.184.34.132:8002`. Assert `_resolveProviderIps` health-checks only the public address and returns it.

- [ ] **Step 6: Defer store integration test execution unless explicitly requested**

Do not run tests without an explicit user request.

- [ ] **Step 7: Integrate the helper into provider-read resolution**

Import `browserUsableProviderRoutes`, apply it after v4/empty normalization, remove the raw first-two truncation, and health-check every browser-usable public candidate. Leave `_resolveNodeIps`, `getNodeIpByHostId`, and `resolveWritableHostIp` unchanged.

- [ ] **Step 8: Perform static review**

Inspect the complete diff, confirm provider-read resolution is the only runtime
path changed, and confirm writable-host and recovery code is untouched. Test
execution is deferred unless the user explicitly requests it.

- [ ] **Step 9: Review and commit**

Review the diff for mutation, root/access-node, and recovery callers. Commit only the helper, tests, store integration, and plan with message `fix: prefer public provider routes for web deep links`.
