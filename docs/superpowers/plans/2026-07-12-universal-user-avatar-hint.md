# Universal User Avatar Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the technical hover hint an intrinsic feature of every resolved user avatar.

**Architecture:** Add a small `UserAvatar` component that centralizes source fallback and tooltip formatting, then migrate all resolved-user avatar images to it without changing their layout or events.

**Tech Stack:** Vue 3, TypeScript, Vue Test Utils, Vitest.

### Task 1: Build and test UserAvatar

- [ ] Write failing component tests for tooltip text, missing values, source override, and forwarded attributes.
- [ ] Implement `src/components/UserAvatar.vue` and export it.
- [ ] Run the focused tests.

### Task 2: Migrate avatar call sites

- [ ] Replace resolved-user avatar images in views and components.
- [ ] Remove local tooltip formatting and unused `avatarSrc` imports.
- [ ] Search for remaining resolved-user avatar images and duplicate technical tooltip strings.

### Task 3: Verify

- [ ] Run all unit tests.
- [ ] Run type checking and production build.
- [ ] Inspect the final diff and run `git diff --check`.
