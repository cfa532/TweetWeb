# Detail and Profile Reload Recovery Design

## Goal

Keep routine Tweet Detail and profile navigation lightweight while retaining explicit recovery synchronization when the user reloads the browser page.

## Behavior

- Opening Tweet Detail through app navigation uses the ordinary `get_tweet` read path and must not call `refresh_tweet`.
- Opening a Tweet Detail URL directly in a new browser navigation also uses the ordinary read path.
- Reloading the browser while Tweet Detail is displayed calls `refresh_tweet` after the initial content is rendered, then continues loading comments through the existing comment path.
- Navigating from one Tweet Detail route to another is ordinary navigation, not a browser reload.
- Quote tweets and pure retweets retain their existing choice of which outer/original tweet is refreshed.
- Opening a profile through app navigation or a direct URL uses ordinary reads and does not call `resync_user`.
- Reloading the browser while a profile is displayed refreshes the user and pinned tweets, then calls `resync_user` only when the user's read node differs from the root node.
- Profile back/forward activation and switching between profiles do not call `resync_user`.

## Implementation

Use one shared helper around the browser's Navigation Timing entry to classify the document navigation. Gate `resyncDetailTweets()` and profile recovery on a navigation type of `reload`.

Make the store's existing `forceRefresh` argument control use of `refresh_tweet`. A cache miss with `forceRefresh: false` must fall through to the normal `get_tweet` provider path even when an author ID is supplied. A forced request keeps the existing author-node `refresh_tweet` behavior.

This separates ordinary reads from explicit synchronization as required by the shared Leither data and synchronization contract. No new persistent state or route flags are needed.

Add a store action for `resync_user` rather than placing RPC parsing in `UserPage`. The action follows iOS: send the v3 request through the user's current read route, validate the returned user, merge it into cached user references, and merge valid returned tweets through the existing tweet-cache path. After the normal profile content is rendered, `UserPage` starts it without awaiting it and only after a forced user refresh confirms `hostIds[1]` differs from `hostIds[0]`. Returned data is merged into the currently visible profile only if the route still names the same user.

## Compatibility and Failure Handling

If Navigation Timing is unavailable or has no navigation entry, classify the load as ordinary navigation and do not force synchronization. Neither `refresh_tweet` nor `resync_user` may block initial rendering or control loading/error UI. Returned updates merge into the visible screen only if its route target is still current. Recovery failures keep cached content visible. Existing loading retries, timeout UI, comment polling, profile pagination, and explicit retry behavior remain unchanged.

## Tests

- Verify browser navigation types: `reload` enables recovery; `navigate`, `back_forward`, missing entries, and unavailable timing APIs do not.
- Verify a non-forced store fetch uses `get_tweet` rather than `refresh_tweet` when an author ID is present.
- Verify a forced store fetch retains `refresh_tweet`.
- Verify profile recovery is disabled for ordinary navigation and enabled for reload.
- Verify profile recovery skips `resync_user` when read and root host IDs match.
- Verify `resync_user` merges its user and tweet result into existing caches.
- Run focused unit tests, type checking, and the production build.
