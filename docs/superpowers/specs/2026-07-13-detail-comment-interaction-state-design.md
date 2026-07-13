# Detail Comment Interaction State Design

## Problem

TweetWeb can hold separate objects for the same comment in the tweet detail list and in the login user's saved lists. The saved-list loader records authoritative favorite/bookmark membership in `interactionOverrides`, but `TweetActionBar` reads only the object-local `favorites` array. An already-rendered detail comment can therefore show an empty heart while the same comment shows a filled heart in Favorites.

Android does not exhibit this mismatch because all representations share a singleton `Tweet` by ID. Saved-list membership and detail-comment merging correct that shared object's interaction flags before the action buttons read them.

## Design

Treat TweetWeb's existing `interactionOverrides` map as the canonical per-user interaction state for any tweet ID it knows. Add store helpers that resolve favorite/bookmark flags by applying explicit overrides over the tweet payload and that update one override for optimistic UI.

`TweetActionBar` will use the resolved flags for icon rendering, toggle direction, count changes, rollback, and the request snapshot. An optimistic toggle will update the override before emitting the updated tweet; a failed request will restore the previous override. The successful server response remains authoritative and updates the same registry through `_applyServerTweet`.

The existing detail loader continues applying known overrides when creating comment objects. Logout continues clearing the registry, preventing interaction state from leaking between users.

## Rejected Approaches

- Scanning all loaded tweets and nested comments: duplicates propagation logic, depends on object reachability, and misses future rendering locations.
- Converting all Web tweets to singleton objects: much broader than the observed bug.
- Loading all saved lists before every detail view: unnecessary network and memory cost.

## Verification

Unit tests will cover explicit `true` overriding stale `false`, explicit `false` overriding stale `true`, and preserving unrelated flag slots. Action-bar integration will use the resolved state for both display and toggle behavior. Type checking and the production build must pass.
