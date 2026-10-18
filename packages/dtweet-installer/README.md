# dTweet node installer

`@inoku/dtweet` installs Leither, synchronizes and provides the public dTweet
release application, and installs tus-server **inside the selected Leither
directory**. It follows LifeAlbum's npm installer approach: reuse an existing
node, download a verified runtime for a fresh node, and install the companion
service alongside it.

Version **0.2.0** includes the colocated upload service and port-management
utility. Version 0.1.0 installs only the Leither node and dTweet application.

## Requirements

- Linux with systemd, or macOS; x64 and arm64 runtime downloads are supported.
- Node.js 22 or newer and npm.
- FFmpeg and ffprobe on the installing account's PATH. Install FFmpeg with your
  operating system's package manager before setup.
- Run as the account that owns the node. Service registration uses sudo; the
  services run as that account. `--no-services` allows manual service management.

Windows is not supported by this installer version. It retains the existing
Linux/macOS scope rather than changing the upload service for Windows shells.

## Install from the package

Build an installable tarball from the TweetWeb source:

```sh
cd packages/dtweet-installer
npm pack
```

Then run the tarball on the computer that will host the node:

```sh
npm exec --yes --package ./inoku-dtweet-0.2.0.tgz -- dtweet \
  --leither-root /path/to/Leither --tus-port 8010
```

Install the pinned registry version with:

```sh
npx --yes @inoku/dtweet@0.2.0 --leither-root /path/to/Leither --tus-port 8010
```

With no directory option, setup selects the sole running Leither instance,
otherwise an existing `./Leither`, otherwise `~/Leither`. Multiple running nodes
require `--leither-root`. Fresh nodes use Leither port **8800** and upload port
**8010** by default. Set the dTweet profile's `cloudDrivePort` to the chosen
upload port and permit both service ports through your router/firewall.
The installer does not alter firewall rules or profile data.

## Installed layout

```text
Leither/
  Leither                     Existing or downloaded executable
  SystemVars.json             Leither node settings
  hostkey.cfg, ds/, ...        Leither identity and storage
  tus-server/
    app.js, ...               Bundled upload service
    dtweet-start.cjs           Launcher tied to this Leither node
    package.json
    package-lock.json
    node_modules/             Locked production dependencies
    port                      Upload port number, for example 8010
    uploads/                  Uploads and resumable-upload state
    logs/
    .dtweet-install.json       Installer version and source hashes
    .dtweet-service            Generated service definition
```

**No `.env` file is created or loaded.** The only upload configuration file is
`tus-server/port`, containing a port number. The launcher derives the Leither
binary path and service port from its parent directory and `SystemVars.json`.
It runs Leither CLI children from that node's directory and explicitly selects
that node for RPC, even when several nodes are running.

The existing upload service's authorization checks remain in place. The
installer supplies no private-drive username, network-drive path, credentials,
or X session. Those optional routes retain their existing authorization rules;
this package does not enable them by removing authentication. The machine-specific
X/Playwright integration is disabled for this portable installation.

## Services and existing nodes

A fresh Leither node gets its own systemd service on Linux or LaunchDaemon on
macOS. An already-running Leither process is never restarted or replaced. An
existing node's service manager is retained; a stopped existing node without an
installer-owned service uses the prior `Leither run -d` behavior, so its operator
continues to manage startup after reboot.

The upload service also gets a per-node systemd service or LaunchDaemon. Names
include a hash of the Leither directory so installations do not share a service
name. Setup prints both the service name and upload directory. Linux upload
services are named `dtweet-tus-<hash>.service`; macOS labels are
`uk.inoku.dtweet.tus.<hash>`.

To install files without registering services:

```sh
npm exec --yes --package ./inoku-dtweet-0.2.0.tgz -- dtweet \
  --leither-root /path/to/Leither --no-services
node /path/to/Leither/tus-server/dtweet-start.cjs
```

In this mode Leither is still started with `run -d` if needed, and upload startup
is manual. Keep Leither's native public port accessible: this package does not
implement the experimental shared-port proxy.

## Change the upload port

Use the utility command instead of editing the configuration file:

```sh
dtweet set-tus-port 8012 --leither-root /path/to/Leither
```

With the local tarball, run:

```sh
npm exec --yes --package ./inoku-dtweet-0.2.0.tgz -- dtweet \
  set-tus-port 8012 --leither-root /path/to/Leither
```

The command accepts ports 1024–65535, rejects Leither's port and occupied
ports, and atomically updates the saved number. It prints an availability check
before saving; an occupied port or permission error produces a warning and leaves
the existing port and services unchanged. It restarts a running managed
upload service and waits for its health response on the new port. A stopped
service stays stopped and uses the new number on its next start. Leither is
never restarted, and no application sync or runtime download is performed.
If restart fails, the error identifies the saved port and service to inspect;
the command does not silently restore a different port.

For a manually managed installation, stop its upload process first and add
`--no-services`; then start it again using your own service manager. Omitting
`--leither-root` uses the existing node-selection rules without creating a node.
After changing the port, update the dTweet profile's `cloudDrivePort` and
firewall/router rules to match. A service restart interrupts active requests;
resumable-upload state remains on disk.

## Upgrades and preservation

A matching installed version is reused. Use a new package version with
`--upgrade` to replace a tus-server managed by this installer:

```sh
npx --yes @inoku/dtweet@<new-version> --leither-root /path/to/Leither --upgrade
```

Dependencies are installed in a staging directory before the running upload
service is stopped. An upgrade replaces installer-owned code and dependencies,
retaining `port`, uploads, upload registries, logs and other runtime data. The
previous code and configuration are saved under `<Leither root>/.dtweet-backups/`.
Only the managed upload service is stopped/started; Leither keeps running.
Active uploads may be interrupted by that service restart; resumable state stays
on disk. Local edits to managed source files and an existing unmanaged
`tus-server` directory cause setup to stop rather than overwrite them.

An existing tus-server outside the Leither directory is not moved, stopped or
adopted automatically. A port already used by that service must be freed during
an operator-managed migration, or a different upload port selected for the new
installation. Back up uploads and configuration before such a migration.

Existing Leither binaries, configuration, identities and applications are
retained. The installer does not upgrade the Leither executable or republish
user data. It synchronizes and provides release app MID
`heWgeGkeBX2gaENbIBS_Iy1mdTS`, preserving the prior installer behavior.

## Options

Show general or command-specific help without inspecting or changing a node:

```sh
dtweet help
dtweet help set-tus-port
dtweet set-tus-port --help
```

`dtweet --help` and `dtweet -h` also show general help.

| Option | Purpose |
| --- | --- |
| `--leither-root DIR` | Select an existing node or a new installation directory |
| `--port NUMBER` | Fresh Leither port, default 8800 |
| `--bootstrap ADDRESS` | Fresh Leither bootstrap peer |
| `--leither-version Vx.y.z` | Pin a fresh runtime download |
| `--tus-port NUMBER` | Fresh upload port, default 8010 |
| `--upgrade` | Upgrade installer-managed tus-server |
| `--no-services` | Leave automatic startup to the operator |
| `--mid` | Print the release app MID without inspecting/installing anything |
| `--help` | Show installer options |

`set-tus-port NUMBER` is a separate utility subcommand. It accepts only
`--leither-root DIR` and `--no-services`, not installation or upgrade options.

New-node options cannot overwrite an existing Leither configuration. Runtime
downloads use the official Leither distribution and verify the SHA-256 sidecar.
The official download endpoint uses HTTP, including its checksum; verification
detects corruption but does not authenticate against network tampering. No remote
shell installer is executed.

## Packaging and publication

`npm pack` runs the prepack bundler, taking an explicit allowlist of production
files from this checkout's `tus-server/`. The package carries those files and a
SHA-256 manifest, so running it does not fetch mutable application code from a
Git branch. It excludes `.env`, uploads, signing keys, cookies, test files,
development tooling and the maintainer's installed dependencies. Node setup
happens only when the user runs `dtweet`; there is no install/postinstall hook.
The target node installs locked production dependencies with
`npm ci --omit=dev --ignore-scripts`.

Review the packed contents before publication. The existing
`publish-dtweet-installer.yml` workflow publishes immutable annotated tags such
as `dtweet-installer-v0.2.0` using npm trusted publishing and provenance. It
checks syntax, creates the bundled package and rejects an existing version with
different contents. Publishing this installer is separate from publishing a
TweetWeb release or changing the gen8 debug deployment.

This change was checked by JavaScript syntax review, package creation and
inspection of the packaged file inventory and hashes. No test suite or live
node installation was run.
