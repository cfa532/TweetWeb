# Shared public port investigation memo

Date: October 18, 2026

## Conclusion and current decision

The port 8011 experiment demonstrated that TweetWeb can reach Leither and
tus-server through one HTTP and WebSocket proxy endpoint. It did not establish
that an HTTP proxy can replace Leither's native public listener while preserving
all node functionality.

The desired design is for Leither to keep ownership of public port 8002 and
forward selected upload requests from its HTTP handler to a local tus-server.
The available source does not include Leither's core listener or HTTP dispatcher,
so the exact insertion point and full protocol compatibility remain unverified.
The next step requires the core source containing `LListener` and HTTP routing.

The experimental local code has been reverted. The existing gen8 debug deployment
is intentionally left unchanged for the ongoing test. This memo is the retained
repository change; it is an investigation record, not an active deployment guide.

## Experimental deployment on gen8

| Public port | Service | Role |
| --- | --- | --- |
| 8002 | Leither | Existing native node listener, web application, RPC and media |
| 8010 | tus-server | Existing uploads, conversion, file browsing and sharing |
| 8011 | Debug reverse proxy | Additional shared HTTP and WebSocket endpoint |

The proxy forwards `/entry`, `/webapi`, `/ws`, `/ws3`, `/mm`, `/ipfs`, `/getvar`
and the TweetWeb browser assets to Leither on `127.0.0.1:8002`. Remaining paths,
including `/health`, `/upload`, conversion/status and cloud-drive routes, go to
tus-server on `127.0.0.1:8010`.

The debug web build prefers the shared page origin and remaps advertised 8002
addresses on the same hostname to 8011. Its upload URL selection keeps requests
on that shared origin without changing saved `cloudDrivePort` values. Other
nodes keep their own endpoints. A DNS alias different from an advertised IP does
not receive that same-host remapping.

Both original public ports remain available. Existing native clients retain
their upload URLs and configured ports. Neither Leither nor tus-server was
restarted or modified by the deployed proxy. Cross-node requests still go to
the appropriate remote nodes; the proxy is not a general cross-node relay.

## Publication and verification

The debug application is `twbe`, AppID `d4lRyhABgqOnqY4bURSm_T-4FZ4`.
The final published version is **1679**. Local and network `last` both reported
1679 with no version or content difference after publication. The preceding
experimental version was 1677; the pre-experiment debug `last` was 1675.

All 27 current production Go backend sources and seven web assets were uploaded
and verified by SHA-256 before publication. The exact HTML and JavaScript were
also verified through public port 8011 for both numbered version 1679 and `last`.
The final JavaScript SHA-256 is:

```text
29dacdf034df0bab6be9b04b34076b3fd17d364b3ffa3219a5b577297de334da
```

Live checks confirmed backend support for both `database` and `tweet-file-v1`,
WebSocket upgrade status 101, upload preflight status 200, and identical
unauthenticated-upload rejection status 403 on ports 8011 and 8010. The browser
rendered profiles and tweets using the published debug bundle. A quoted-author
record had no available provider; that lookup failure was not repaired in this
probe. Authenticated upload, resume and video conversion were not exercised.
Build/type checking and static review passed; no test suite was run.

A direct `/entry?aid=…&ver=…` page initially loaded bare script names from the
node root and could therefore load the release bundle. The experimental build
set its asset base to `/mm/<aid>:<ver>/` before loading scripts. That correction
was included in 1679 and has now been reverted locally with the other probe code.
Domain bootstraps already perform application asset rebasing. The distinction is
covered in the [Leither runtime reference](../../Leither/cfa532-docs/reference/LEITHER_AND_MIMEI.md).

Release `tweet1`, Cloudflare production assets and profile port values were not
changed. The operator's curl configuration binds requests to a VPN interface;
`curl -q` was required for meaningful loopback checks. No network correction
was necessary.

## Listener and routing findings

The installed gen8 executable reports **Leither V0.24.64**, amd64, API 1. Its
observed listeners include IPv4 and IPv6 TCP port 8002. That socket inventory
does not establish which protocols share the listener or how they are dispatched.

The local Leither repository, its inspected upstream tree and cached Go modules
contain API bindings and examples, but not the core listener implementation.
The installed executable has no ELF section header, and Go build metadata and
symbol inspection did not expose the implementation. No conclusion about a safe
HTTP-only replacement listener follows from those inspections.

Native `SetRoute`, `DelRoute` and `ShowRoute` bindings exist in
[`lapi/stub.go`](../../Leither/lapi/stub.go). However, the installed CLI describes
`route` as managing MiMei application routes:

```text
Leither route set <path> <mid[:ver]>
set a route: path -> mid:ver
```

This establishes application routing, not HTTP reverse-proxy support to a local
URL. No route was registered during the inspection. LifeAlbum's separate RPC
bridge to its loopback identity service likewise does not establish a general
streaming HTTP forwarding hook.

## Proposed native forwarding design

Leither would continue accepting all public traffic on its existing advertised
port 8002. Its HTTP dispatcher would forward a defined set of upload-service
paths to a fixed local tus-server origin. Existing peer transport, WebSockets,
RPC, discovery, synchronization and media handlers would retain their existing
listener and dispatch behavior.

Before implementation, inspect the core source for protocol classification,
HTTP route precedence and ownership, streaming/body limits, timeouts and
connection upgrades. Forwarding must preserve TUS POST, PATCH, HEAD and OPTIONS,
metadata and offset headers, cancellation, and public `Location` URLs. It must
leave authorization with the upload service and prevent request-selected
upstream destinations. A route namespace such as `/tus/` would require matching
client and returned-URL changes; it must not be introduced without resolving
existing upload and Leither route conflicts.

After compatibility and deployment verification, tus-server could bind only to
loopback and clients could use 8002 for uploads. Existing clients configured
for 8010 need a transition period or updated configuration before that public
port can be closed. Full node functionality and resumable uploads would need
explicit verification before replacing the experimental setup.

## Retained deployment and recovery information

The running experimental proxy is separate from the reverted local source:

- Service: `tweetweb-debug-proxy.service`.
- Runtime directory: `/home/pi/tweetweb-debug-proxy/`.
- Published debug package: `/home/pi/demo/twbe/`, version 1679.
- Original debug-package backup:
  `/home/pi/demo/deploy-backups/shared-port-debug-8011-20261018/twbe/`.
- Intermediate backup before the asset-base correction:
  `/home/pi/demo/deploy-backups/shared-port-debug-8011-before-entry-base/`.
- Publication logs: `/home/pi/demo/logs/twbe-debug-8011-20261018.log` and
  `/home/pi/demo/logs/twbe-debug-8011-entry-base-20261018.log`.

The earlier port-8010 in-process proxy proposal was staged but never installed.
It must not be mistaken for the active 8011 service. The deployed service and
package preserve copies of the experiment even though its local source files
have been removed.

Stopping/disabling the debug proxy would remove only the extra 8011 endpoint;
the original 8002 and 8010 services would remain. Reverting the published debug
application requires a separate normal publication from the selected prior
source, preserving the File-capable backend. Neither action was performed as
part of the local code rollback. No user data was migrated or reverted.
