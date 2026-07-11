# Tweet Detail Reload Refresh Design

## Goal

Keep routine Tweet Detail navigation lightweight while retaining an explicit recovery refresh when the user reloads the browser page.

## Behavior

- Opening Tweet Detail through app navigation uses the ordinary `get_tweet` read path and must not call `refresh_tweet`.
- Opening a Tweet Detail URL directly in a new browser navigation also uses the ordinary read path.
- Reloading the browser while Tweet Detail is displayed calls `refresh_tweet` after the initial content is rendered, then continues loading comments through the existing comment path.
- Navigating from one Tweet Detail route to another is ordinary navigation, not a browser reload.
- Quote tweets and pure retweets retain their existing choice of which outer/original tweet is refreshed.

## Implementation

Use the browser's Navigation Timing entry to classify the document navigation once when the component is created. Gate `resyncDetailTweets()` on a navigation type of `reload`.

Make the store's existing `forceRefresh` argument control use of `refresh_tweet`. A cache miss with `forceRefresh: false` must fall through to the normal `get_tweet` provider path even when an author ID is supplied. A forced request keeps the existing author-node `refresh_tweet` behavior.

This separates ordinary reads from explicit synchronization as required by the shared Leither data and synchronization contract. No new persistent state or route flags are needed.

## Compatibility and Failure Handling

If Navigation Timing is unavailable or has no navigation entry, classify the load as ordinary navigation and do not force synchronization. Existing loading retries, timeout UI, comment polling, and explicit retry behavior remain unchanged.

## Tests

- Verify browser navigation types: `reload` enables recovery; `navigate`, `back_forward`, missing entries, and unavailable timing APIs do not.
- Verify a non-forced store fetch uses `get_tweet` rather than `refresh_tweet` when an author ID is present.
- Verify a forced store fetch retains `refresh_tweet`.
- Run focused unit tests, type checking, and the production build.
