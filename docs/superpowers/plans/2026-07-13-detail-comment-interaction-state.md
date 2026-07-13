# Detail Comment Interaction State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TweetWeb detail-comment favorite and bookmark buttons use the same authoritative per-ID interaction state as saved-list rows.

**Architecture:** Keep `interactionOverrides` as the Web equivalent of Android's singleton interaction state. Resolve it centrally in the tweet store, then make `TweetActionBar` use the resolved flags for rendering and optimistic toggle behavior.

**Tech Stack:** Vue 3, Pinia, TypeScript, Vitest

## Global Constraints

- Do not scan loaded tweet trees or refactor tweets into singletons.
- Explicit `false` overrides must be preserved as strongly as explicit `true` overrides.
- Clear per-user interaction state on logout.
- Continue routing comment writes through `interactionHostAuthor`.

---

### Task 1: Canonical Interaction-State Resolver

**Files:**
- Modify: `src/stores/tweetStore.ts`
- Test: `src/stores/tweetStore.interactionState.test.ts`

**Interfaces:**
- Produces: `resolvedInteractionFlags(tweet: Tweet): boolean[]`
- Produces: `setInteractionOverride(tweetId: string, kind: 'favorite' | 'bookmark', value: boolean): void`

- [ ] **Step 1: Write failing store tests**

Test that a favorite override of `true` replaces stale `false`, a bookmark override of `false` replaces stale `true`, and the third retweet slot is preserved.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run test:unit -- --run src/stores/tweetStore.interactionState.test.ts`

Expected: failure because `resolvedInteractionFlags` and `setInteractionOverride` do not exist.

- [ ] **Step 3: Implement the minimal store helpers**

Copy the tweet's flags into a three-slot array, apply only defined override values, and update only the requested override key without discarding the other key.

- [ ] **Step 4: Run the focused test and verify success**

Run: `npm run test:unit -- --run src/stores/tweetStore.interactionState.test.ts`

Expected: all interaction-state tests pass.

### Task 2: Action-Bar Integration

**Files:**
- Modify: `src/views/TweetActionBar.vue`

**Interfaces:**
- Consumes: `tweetStore.resolvedInteractionFlags(tweet)`
- Consumes: `tweetStore.setInteractionOverride(tweetId, kind, value)`

- [ ] **Step 1: Render from resolved flags**

Replace direct `props.tweet.favorites` reads with a computed resolved array for favorite and bookmark icons.

- [ ] **Step 2: Toggle from the same resolved baseline**

Build the request/rollback snapshot with resolved flags. Update the appropriate override before emitting the optimistic state, and restore it on failure.

- [ ] **Step 3: Run full verification**

Run: `git diff --check && npm run test:unit -- --run src/stores/tweetStore.interactionState.test.ts && npm run type-check && npm run build-only`

Expected: clean diff, passing focused tests, successful type check, and successful production build.
