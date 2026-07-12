# Universal User Avatar Hint Design

All resolved user avatars use one `UserAvatar` component. It owns avatar fallback and a native tooltip containing User ID, root Host ID, and Base IP, while forwarding existing classes and event handlers. App logos and unresolved loading placeholders remain ordinary elements.

Follower/following rows, tweet and comment headers, detail headers, profile/account headers, editor avatars, account-menu avatars, and new-tweet banner avatars use the component. Editable previews use it whenever a resolved user is available, with the preview URL passed as an override.

Tests verify consistent tooltip text, fallback values, source overrides, and forwarded attributes.
