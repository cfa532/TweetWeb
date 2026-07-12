# Detail and Profile Reload Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `refresh_tweet` and `resync_user` only when the corresponding Web page is reloaded, never on routine navigation.

**Architecture:** A small shared navigation helper identifies browser reloads. Tweet Detail gates its existing non-blocking recovery call with that helper, while the store makes `forceRefresh` authoritative. After normal content renders, User Profile starts v3 `resync_user` in the background through a dedicated store action and applies results only while the same profile remains active.

**Tech Stack:** Vue 3, TypeScript, Pinia, Vue Router, Vitest, Navigation Timing API.

## Global Constraints

- Normal screen opening must use ordinary reads.
- Explicit synchronization must remain available as reload recovery.
- `resync_user` runs only when the user's read node differs from the root node.
- Recovery failures preserve cached content.
- Recovery operations never block initial rendering or control loading/error UI.
- Stale recovery results never update a different route target.
- Do not add persistent flags or change backend contracts.

---

### Task 1: Shared Browser Reload Detection

**Files:**
- Create: `src/lib/navigation.ts`
- Test: `src/lib/navigation.test.ts`
- Modify: `src/lib/index.ts`

**Interfaces:**
- Produces: `isBrowserReload(performanceApi?: Pick<Performance, 'getEntriesByType'>): boolean`.

- [ ] Write tests covering `reload`, `navigate`, `back_forward`, missing entries, and unavailable APIs.
- [ ] Run `npm run test:unit -- src/lib/navigation.test.ts --run` and confirm the missing helper causes the expected failure.
- [ ] Implement a defensive Navigation Timing lookup and export it from `src/lib/index.ts`.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Reload-Only Tweet Recovery

**Files:**
- Modify: `src/components/TweetDetail.vue`
- Modify: `src/stores/tweetStore.ts`
- Test: `src/stores/tweetStore.reloadRecovery.test.ts`

**Interfaces:**
- Consumes: `isBrowserReload()` from Task 1.
- Preserves: `getTweet(tweetId, authorId, useRacing, forceRefresh, fromDetailView)`.

- [ ] Write a store regression test showing `forceRefresh: false` uses `get_tweet` with an author ID while `forceRefresh: true` uses `refresh_tweet`.
- [ ] Run the focused test and confirm the ordinary-read assertion fails.
- [ ] Restrict the author-node `refresh_tweet` branch to forced requests and gate `resyncDetailTweets()` on `isBrowserReload()`.
- [ ] Re-run navigation and store tests and confirm they pass.

### Task 3: Reload-Only Profile Recovery

**Files:**
- Modify: `src/components/UserPage.vue`
- Modify: `src/stores/tweetStore.ts`
- Test: `src/stores/tweetStore.reloadRecovery.test.ts`

**Interfaces:**
- Produces: `resyncUser(userId: MimeiId): Promise<{ user: User; tweets: Tweet[] }>`.
- Consumes: `isBrowserReload()` and existing `getUser(userId, true)`, `loadPinnedTweets`, and `loadTweetsByUser` paths.

- [ ] Add failing tests for matching-host skip logic and v3 `resync_user` response/cache normalization.
- [ ] Run the focused tests and confirm the missing action/logic fails as expected.
- [ ] Implement the store action and a small host comparison helper.
- [ ] After initial profile content renders, start recovery without awaiting it only for a browser reload; merge returned data only if the same author route remains active.
- [ ] Re-run focused tests and confirm they pass.

### Task 4: Verification and Review

**Files:**
- Review all modified files and callers of `getTweet` and `resyncUser`.

- [ ] Run `npm run test:unit -- --run`.
- [ ] Run `npm run type-check`.
- [ ] Run `npm run build-only`.
- [ ] Run `git diff --check` and inspect the final diff for unintended lifecycle or cache changes.
