# Fallback audit — 2026-10-22

Static audit of the current local working trees for TweetWeb, its upload service and installer, Android, iOS and its Cloudflare Worker, and the active Go backend. This report does not claim that every branch was exercised or that every listed risk caused the Safari upload incident. No application code was changed, no tests/builds were run for this audit, and nothing was deployed. Existing uncommitted work was preserved.

**Coverage:** repository-wide pattern scanning for explicit fallback/default behavior, swallowed errors, empty-result substitutions, route clearing, success defaults and recovery. Higher-risk matches were followed through their callers, state writes and response handling. Dependencies, bundled/minified third-party code, generated build outputs, tests, documentation and the deprecated JavaScript backend were excluded. This is a broad static scan with targeted call-path review, not a line-by-line proof of all behavior.

| Area | First-party source/support files scanned | Candidate lines |
| --- | ---: | ---: |
| TweetWeb runtime | 102 | 468 |
| Android, including Play/fullPlay variants | 128 | 716 |
| iOS and Worker | 150 | 1213 |
| Go backend | 28 | 8 |

**Priority:** P1 means data loss, false delivery, unproven account routing or wrong release identity. P2 means hidden operation failures, configuration guesses or misleading state. “Policy” and “configuration review” findings are existing intentional behavior or unresolved configuration semantics, not a blanket recommendation to delete every fallback.

The scan covered 408 files. Build configuration and variant entry points were also inspected for signing and startup behavior; inactive root-level browser/utility copies were checked for active references rather than treated as deployed runtime paths.

## 19 findings

### F01 — P1: iOS deletes the persistent store on an arbitrary load failure

CoreDataManager calls recoverFromError for every loadPersistentStores error. Recovery destroys TweetModel.sqlite and recreates it without distinguishing an unavailable store from a migration or corruption problem.

**Consequence:** Local messages, cached sessions and other entities in that store can be lost. This is a destructive recovery operation, not an error report.

**Correction direction:** Preserve the existing store on load failure. Diagnose the particular error; migration or destructive reset must be a separate, deliberate decision.

**Source:** [Core/CoreDataManager.swift:34](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/CoreDataManager.swift:34) · [Core/CoreDataManager.swift:52](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/CoreDataManager.swift:52)

### F02 — P1: Android database migration can delete stored data

ChatDatabase version 9 has no registered migration path and enables fallbackToDestructiveMigration(true). TweetCacheDatabase also enables destructive fallback, while registering only migrations 10→11→12→13→14.

**Consequence:** An upgrade without a supported migration path can recreate the database. Chat history/session data are affected in ChatDatabase; TweetCacheDatabase also contains the reliability blacklist. The false argument on the latter call does not turn destructive migration off; it controls whether tables outside Room’s managed schema are also dropped. See the [Room builder API](https://developer.android.com/reference/androidx/room/RoomDatabase.Builder#fallbackToDestructiveMigration(boolean)).

**Correction direction:** Supply the required migrations and fail visibly for unsupported versions. Do not automatically recreate user data to complete an upgrade.

**Source:** [datamodel/ChatMessage.kt:502](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/datamodel/ChatMessage.kt:502) · [datamodel/TweetDAO.kt:242](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/datamodel/TweetDAO.kt:242)

### F03 — P1: Native message delivery accepts missing success acknowledgements

Android sendMessage treats a map without a Boolean success field, and every response outside the Boolean/map cases, as success. iOS treats a dictionary as successful unless it explicitly contains success=false; this occurs in both sender and recipient delivery paths.

**Consequence:** A malformed or unexpected response can become a positive delivery result. Android also accepts null through its else branch. Existing valid legacy response shapes should be handled explicitly rather than through default success.

**Correction direction:** Require one of the documented positive acknowledgement shapes, including the current sent/envelope form. Propagate unknown or malformed replies as errors.

**Source:** [HproseInstance.kt:1372](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/HproseInstance.kt:1372) · [Core/HproseInstance.swift:8541](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/HproseInstance.swift:8541) · [Core/HproseInstance.swift:8384](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/HproseInstance.swift:8384)

### F04 — P1: Android still clears baseUrl when replacement discovery fails

resolveAndUpdateBaseUrl sets user.baseUrl=null when getProviderIP returns no healthy address. updateUserFromServerWithRetry retains originalBaseUrl only as a local value and does not restore it when retries end. The user may be a shared account instance.

**Consequence:** Failure to discover a replacement is treated as a reason to erase the current route, including a previously populated one. clearHproseService is called after setting null, but immediately returns when baseUrl is null, so that cleanup does not clear the old client as intended.

**Correction direction:** Keep candidate discovery separate from the existing route. Replace the route only after the replacement is proven usable; surface discovery failure without clearing unrelated live state.

**Source:** [HproseInstance.kt:5677](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/HproseInstance.kt:5677) · [HproseInstance.kt:5703](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/HproseInstance.kt:5703) · [datamodel/User.kt:258](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/datamodel/User.kt:258)

### F05 — P1: Native startup substitutes an entry node for an unresolved account route

Android initAppEntry assigns findEntryIP results to appUser.baseUrl after provider resolution/fetch failures and can mark cached account data initialized before get_user succeeds. iOS initAppEntry assigns finalEntryIP to appUser.baseUrl and marks initialization complete when fetchUser returns no user.

**Consequence:** An entry node that supports discovery is not proof of a provider for that account. Account operations can be directed to an unproven node while initialization is reported as complete.

**Correction direction:** Keep entry discovery and account routing distinct. Preserve the login identity offline, but leave account networking unavailable until a get_user response proves the route.

**Source:** [HproseInstance.kt:1115](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/HproseInstance.kt:1115) · [HproseInstance.kt:1049](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/HproseInstance.kt:1049) · [Core/HproseInstance.swift:1114](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/HproseInstance.swift:1114)

### F06 — P1: Upload registry read errors become empty writable registries

readJson returns the fallback object for JSON parsing and filesystem read errors. JsonRegistry.set/update/delete read that value and then write it back. The files, shares and download-session registries all use {} as their fallback.

**Consequence:** A corrupted or temporarily unreadable registry can be overwritten by an empty/partial replacement on the next mutation, losing unrelated records. A legitimately absent first-run file is a different case.

**Correction direction:** Distinguish a missing initial registry from a failed read. Abort mutations on parse/access errors and preserve the original file.

**Source:** [tus-server/fileRegistry.js:10](/Users/cfa532/Documents/GitHub/TweetWeb/tus-server/fileRegistry.js:10) · [tus-server/fileRegistry.js:48](/Users/cfa532/Documents/GitHub/TweetWeb/tus-server/fileRegistry.js:48) · [tus-server/fileRegistry.js:84](/Users/cfa532/Documents/GitHub/TweetWeb/tus-server/fileRegistry.js:84)

### F07 — P1: Android release signing silently uses the debug key

If keystore.properties does not exist, the release signing configuration copies debugLocal credentials. The release build type uses that configuration.

**Consequence:** A release artifact can be produced with a development certificate instead of failing because release credentials are missing. It will not match the intended production signing identity.

**Correction direction:** Make release signing requirements explicit and fail release configuration when they are unavailable. Keep debug signing in debug builds.

**Source:** [app/build.gradle.kts:68](/Users/cfa532/Documents/GitHub/Tweet/app/build.gradle.kts:68) · [app/build.gradle.kts:102](/Users/cfa532/Documents/GitHub/Tweet/app/build.gradle.kts:102)

### F08 — P1 / policy: Reliability failures can become permanent suppression and remote relationship deletion

Both native clients promote repeated access failures to a persisted permanent reliability blacklist. On iOS the profile-list callback invokes removePermanentlyBlacklistedUser; the Go endpoint removes an older follower/following relationship once the failure-count/age threshold is met. It protects newer relationships, but an old relationship is still deleted because of access failure history.

**Consequence:** A prolonged outage can stop resources being retried and, on iOS, alter the user’s social graph. This is an intentional existing cleanup policy, not proof that the remote account or relationship is invalid.

**Correction direction:** Treat this as a product-policy decision before changing it. Network availability and a user’s follow/fan relationship should not be conflated; keep any circuit breaker separate from relationship mutation.

**Source:** [Core/BlackList.swift:126](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/BlackList.swift:126) · [datamodel/BlackList.kt:28](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/datamodel/BlackList.kt:28) · [Features/Home/HomeViewModel.swift:385](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Features/Home/HomeViewModel.swift:385) · [Core/HproseInstance.swift:3864](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/HproseInstance.swift:3864) · [feed_entries.go:381](/Users/cfa532/Documents/GitHub/TweetBackendApp/feed_entries.go:381)

### F09 — P2: iOS RPC URL construction invents an IPv6 port

HproseClientPool.urlString(forIP:) appends :8080 if it cannot parse the final IPv6 component as a port. A numeric final hextet is instead interpreted as a port.

**Consequence:** Malformed or port-less advertised addresses can be converted to a different endpoint. This repeats the guessed-port pattern; it is unrelated to the app’s legitimate local media-server port.

**Correction direction:** Require the advertised host/port representation to be unambiguous. Report invalid remote addresses instead of supplying a remote service port.

**Source:** [Core/HproseClientPool.swift:175](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/HproseClientPool.swift:175)

### F10 — P2 / configuration review: The installer still substitutes Leither port 4800

tus-launcher.cjs reads SystemVars.json but uses config.ServicePort ?? 4800. tus.js uses the same assumption when checking port conflicts.

**Consequence:** An absent effective service setting becomes a guessed remote endpoint. Whether an omitted field is a documented Leither default needs confirmation from Leither’s effective configuration; this audit does not claim an installed node currently hits that branch.

**Correction direction:** Obtain the selected service’s effective configured port. Do not reintroduce the removed gen8 workaround or a second guessed port.

**Source:** [packages/dtweet-installer/lib/tus-launcher.cjs:9](/Users/cfa532/Documents/GitHub/TweetWeb/packages/dtweet-installer/lib/tus-launcher.cjs:9) · [packages/dtweet-installer/lib/tus.js:76](/Users/cfa532/Documents/GitHub/TweetWeb/packages/dtweet-installer/lib/tus.js:76)

### F11 — P2: Upload parsers accept arbitrary response text as an identifier

iOS uploadCompressedHLS returns the entire trimmed HTTP-200 response when JSON jobId parsing fails. Both ZIP-processing implementations in tus-server similarly keep the full CLI output as cid when CID extraction fails.

**Consequence:** Malformed success responses or command output are accepted as job IDs/CIDs. Later status polls or media URLs fail instead of exposing the original protocol error.

**Correction direction:** Accept only explicit supported identifier formats. Fail at the parse boundary when no valid identifier was returned.

**Source:** [Core/HproseInstance.swift:6786](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/HproseInstance.swift:6786) · [tus-server/zipRoutes.js:623](/Users/cfa532/Documents/GitHub/TweetWeb/tus-server/zipRoutes.js:623)

### F12 — P2: Web relationship load failures are represented as empty lists

_loadSortedUserList returns [] when user resolution fails or both RPC attempts fail. Followings.vue additionally resolves its timeout promise with [] and assigns that to the visible list.

**Consequence:** The UI cannot distinguish a failed request from a user with zero followings/followers. On timeout, a later successful underlying request does not replace the already selected empty Promise.race result.

**Correction direction:** Preserve already displayed data and expose a load error. Represent an empty list only after a successful list response.

**Source:** [src/stores/tweetStore.ts:904](/Users/cfa532/Documents/GitHub/TweetWeb/src/stores/tweetStore.ts:904) · [src/components/Followings.vue:127](/Users/cfa532/Documents/GitHub/TweetWeb/src/components/Followings.vue:127)

### F13 — P2: Media routing substitutes unrelated hosts when the owner route is absent

Web VideoJS uses window.location.origin if neither author.providerIp nor tweet.provider exists. Android fullscreen video and share-preview code use appUser.baseUrl or the build’s BASE_URL. iOS User.avatarUrl uses HproseInstance.baseUrl when the user has no baseUrl.

**Consequence:** A missing owner/provider route is turned into a request to an entry node or another account’s server. This may happen to work if that node has the content, but its possession is unproven; failures become opaque missing-media/404 errors.

**Correction direction:** Keep the media identity and its proven serving route together. Resolve or report a missing route rather than constructing one from unrelated application state.

**Source:** [src/views/VideoJS.vue:1618](/Users/cfa532/Documents/GitHub/TweetWeb/src/views/VideoJS.vue:1618) · [widget/FullScreenPlayerManager.kt:267](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/widget/FullScreenPlayerManager.kt:267) · [viewmodel/TweetViewModel.kt:879](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/viewmodel/TweetViewModel.kt:879) · [DataModels/User.swift:601](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/DataModels/User.swift:601)

### F14 — P2 / policy: Native video-upload failures can switch the delivered media format

Android MediaUploadService sends the original/progressive file when normalization fails, cloudDrivePort is absent, or the conversion service is unavailable. iOS checkCloudDriveService catches network/service errors and returns false, allowing the progressive-MP4 path.

**Consequence:** An unavailable conversion path can yield a different published media type/size/streaming behavior rather than a visible conversion error. Some of these branches are intentional product routing, so removing them indiscriminately would change supported uploads.

**Correction direction:** Distinguish an explicitly selected progressive upload from a failed requested conversion. Decide which automatic downgrade behavior the product should permit.

**Source:** [service/MediaUploadService.kt:200](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/service/MediaUploadService.kt:200) · [service/MediaUploadService.kt:229](/Users/cfa532/Documents/GitHub/Tweet/app/src/main/java/us/fireshare/tweet/service/MediaUploadService.kt:229) · [Core/HproseInstance.swift:6071](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/HproseInstance.swift:6071)

### F15 — P2: iOS chat caching swallows persistence failures and fabricates a last message

ChatCacheManager ignores several fetch/save errors. A failed fetch can take the create-new-session path, and failure to find/decode a last message synthesizes a ChatMessage with unknown identities, content "Message", and the current time.

**Consequence:** A failed cache operation looks like absent data or a real placeholder message. Save failures are invisible, and the manufactured identity/time can misrepresent chat history.

**Correction direction:** Keep missing data distinct from storage/decoding failure. Expose a missing-preview state without manufacturing a message record; retain the original persistence error.

**Source:** [Core/ChatCacheManager.swift:22](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/ChatCacheManager.swift:22) · [Core/ChatCacheManager.swift:40](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/ChatCacheManager.swift:40) · [Core/ChatCacheManager.swift:152](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/ChatCacheManager.swift:152)

### F16 — P2: Backend synchronization failure can still be returned as a successful recovery

entryResyncUser records a mimeiSync/auth failure in syncErr, but returns the cached user normally when a local copy remains. The v3 result contains user/tweets and no sync-failure status.

**Consequence:** The client cannot tell a successful fresh synchronization from a failed synchronization that returned old local data. Keeping cached data available is useful; hiding the failed refresh is the issue.

**Correction direction:** Separate the synchronization result from cached-data availability. Propagate the operation error without clearing the cached user or its route.

**Source:** [user_entries.go:547](/Users/cfa532/Documents/GitHub/TweetBackendApp/user_entries.go:547) · [user_entries.go:589](/Users/cfa532/Documents/GitHub/TweetBackendApp/user_entries.go:589)

### F17 — P2: Backend relationship reads turn read errors into hidden recovery and partial success

recoverUser returns nil for get_user_core_data errors, treats the result like an absent copy, then calls mimeiSync and mimeiProvide. Its listing caller drops unresolved users and still returns success=true.

**Consequence:** A normal list read can trigger per-user synchronization, and an underlying read/replication failure becomes a shorter successful-looking list. There is no missing-account versus operation-error distinction in that path.

**Correction direction:** Distinguish an absent copy from a failed read. Keep ordinary listing behavior and explicit synchronization separate; retain page/list identity and report partial failures.

**Source:** [social_entries.go:525](/Users/cfa532/Documents/GitHub/TweetBackendApp/social_entries.go:525) · [social_entries.go:517](/Users/cfa532/Documents/GitHub/TweetBackendApp/social_entries.go:517)

### F18 — P2: iOS blacklist-fetch failure replaces the cached social block list with []

Startup background loading evaluates (try? getListByType(...BLACK_LIST)) ?? [] and assigns it to user.userBlackList. UserListView directly uses that property to filter socially blocked IDs.

**Consequence:** A temporary fetch failure can remove the local blocked-user filtering for that list even though the server-side block list did not change.

**Correction direction:** Keep the cached list when its refresh fails and expose/log the refresh failure; assign [] only for a successful empty server response.

**Source:** [Core/HproseInstance.swift:1098](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Core/HproseInstance.swift:1098) · [Features/Profile/UserListView.swift:292](/Users/cfa532/Documents/GitHub/Tweet-iOS/Sources/Features/Profile/UserListView.swift:292)

### F19 — P2: Android local HLS conversion invents dimensions when metadata is unavailable

The fullPlay converter's calculateActualResolution substitutes landscape 16:9 dimensions when videoResolution is null. Those dimensions feed encoding and the master playlist's RESOLUTION attribute. VideoNormalizer similarly substitutes 1280×720 for bitrate/resampling decisions.

**Consequence:** Missing source metadata becomes assumed media geometry. The encoder preserves the original aspect ratio within that assumed box, so a portrait source can have different actual dimensions from the landscape dimensions written into the master playlist. The normalization path can also skip intended resampling because it compares the invented 1280×720 value to its threshold.

**Correction direction:** Obtain real stream dimensions before making geometry-dependent decisions. Derive playlist dimensions from the actual encoded output; surface metadata failure rather than inventing source dimensions.

**Source:** [fullPlay/video/LocalHLSConverter.kt:503](/Users/cfa532/Documents/GitHub/Tweet/app/src/fullPlay/java/us/fireshare/tweet/video/LocalHLSConverter.kt:503) · [fullPlay/video/LocalHLSConverter.kt:668](/Users/cfa532/Documents/GitHub/Tweet/app/src/fullPlay/java/us/fireshare/tweet/video/LocalHLSConverter.kt:668) · [fullPlay/video/VideoNormalizer.kt:390](/Users/cfa532/Documents/GitHub/Tweet/app/src/fullPlay/java/us/fireshare/tweet/video/VideoNormalizer.kt:390)

## Deliberate compatibility and recovery behavior

These operations were also found. They need to be evaluated by purpose, rather than removed merely because they contain “fallback”:

- Bounded discovery of other advertised providers, with actual get_user/get_tweet reads. The canonical sync contract requires the author-first, then tweet-provider discovery sequence for deep-link reads.
- Explicit resync_user, refresh_tweet and sync_user recovery APIs. Removing them would remove intentional user recovery required by the contract.
- Local cache display while a real server request is pending. A cached display is different from claiming a failed refresh succeeded.
- Avatar placeholders, HTTP-compatible Ed25519 implementation, browser autoplay mute retry, platform MIME inspection, software codec selection and supported HLS playlist-name variants. These do not establish account ownership or authorize a write.
- The shared backend’s v2/v3 response-envelope compatibility and per-object database/File storage dispatch. These preserve older records and cross-client contracts.
- Content-addressed IPFS CLI-to-RPC retry: addPathToIpfs validates the returned CID and still fails if the second mechanism fails. It does not manufacture a CID.
- Default ports for a newly created local listener, such as the local media proxy, are separate from inventing a port for an existing remote Leither service.
- The Cloudflare browser fallback origin is an explicit configured navigation target. It is not an automatically guessed account/provider route.
- VideoJS.fallbackToProgressiveVideo exists but has no call site in the current source; it was not counted as an active operation.
- Android fullPlay retries HLS stream-copy failure through an actual MediaCodec encode and still returns an error if that fails. Normalization/segmentation errors propagate through LocalVideoProcessingService. Its unknown-duration timeout estimates and cleanup warnings are separate from claiming an upload succeeded. Play's splash timeout reveals the UI without establishing a usable account route; the routing substitutions themselves are covered in F05.

## Existing state and rollout limits

The earlier web route-clearing path is already removed in local source and deployed version 1446. This audit did not reintroduce it. The remaining web list-error-to-empty behavior above is a separate path. The gen8 upload-service guessed-port fallback was removed earlier; the installer default in F10 is a separate remaining assumption.

This audit did not inspect user databases/registry files to establish whether old fallback behavior already wrote bad state. If data was already deleted or overwritten, changing source alone cannot recover it. Any cache reset, data restoration or migration needs its own explicit decision; no such action was taken.

No blanket deletion is proposed. Correct the producer/error classification at each confirmed failure boundary, preserve legitimate recovery, and handle intentional media/cleanup policies explicitly.
