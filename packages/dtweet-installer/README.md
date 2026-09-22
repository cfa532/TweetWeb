# dTweet node installer

`@inoku/dtweet` installs Leither, starts the node, synchronizes the public dTweet
release application, and announces the node as a provider of that application.
It follows LifeAlbum's `@inoku/lifedrive` npm launcher approach, with a
dependency-free Node.js installer instead of an application bundle: dTweet's
published application is obtained through Leither synchronization.

Release app MID: **`heWgeGkeBX2gaENbIBS_Iy1mdTS`**.

## Install your node

On the server that will host your dTweet node, run:

```sh
npx --yes @inoku/dtweet@0.1.0
```

**HLS video requires both tus-server and FFmpeg.** This command installs the
Leither runtime and synchronizes/provides the dTweet app. It does not install
the separate upload and video-processing components described below.

## Required setup for HLS video

Install and configure both of these on your upload server:

- **tus-server** accepts video uploads and coordinates video processing and
  storage. Run it as a persistent service connected to your Leither node.
- **FFmpeg**, including **ffprobe**, inspects videos and converts them into HLS
  playlists and segments. Both executables must be available on the `PATH` of
  the account running tus-server.

Follow the [server setup guide](https://github.com/cfa532/TweetWeb/blob/main/docs/SETUP.md)
for tus-server installation, environment configuration, and FFmpeg installation
on your operating system. The
[TUS server documentation](https://github.com/cfa532/TweetWeb/blob/main/docs/TUS_SERVER.md)
describes its upload and HLS conversion endpoints.

Choose an upload-service port distinct from Leither's port, allow it through
your firewall/router, and configure your dTweet profile's `cloudDrivePort` to
match. Completing this npm command alone does **not** mean your server is ready
to accept and convert HLS video uploads.

## Run from source

Requires Node.js 22 or newer and Linux or macOS. Automatic runtime downloads
support x64 and arm64. Process discovery uses `ps`, plus `/proc` on Linux or
`lsof` on macOS. Run as the operating-system account that owns the Leither node.

From the TweetWeb checkout:

```sh
node packages/dtweet-installer/bin/dtweet.js --help
node packages/dtweet-installer/bin/dtweet.js
```

With no arguments, setup selects the sole running Leither instance. Otherwise,
it uses an existing `./Leither` binary or installs into `~/Leither`. Multiple
running nodes require `--leither-root`:

```sh
node packages/dtweet-installer/bin/dtweet.js --leither-root /srv/leither
```

For a new node, the default port is **8800**. Leither supplies its default
bootstrap peers. Override these or pin the runtime download when necessary:

```sh
node packages/dtweet-installer/bin/dtweet.js \
  --leither-root /srv/leither --port 8800 --bootstrap mimei.org \
  --leither-version V0.24.29
```

Print the release MID without inspecting processes or installing anything:

```sh
node packages/dtweet-installer/bin/dtweet.js --mid
```

## Installation behavior

1. Select the Leither directory. Reuse an existing executable and configuration.
2. For a new installation, discover the latest runtime using the official
   [Leither distribution](http://vzhan.cn/mm/Fc1BRTFafOGzq5P8KmkVJqwS2v2/),
   download the platform binary, and verify its SHA-256 sidecar before installing.
3. Initialize a new node with `Leither init -p 8800`, then start it with
   `Leither run -d`. An already-running node is not restarted.
4. Wait up to 60 seconds for `Leither swarm local` to return a TCP address.
5. Run `Leither mimei sync --mid heWgeGkeBX2gaENbIBS_Iy1mdTS`.
6. Only after successful sync, run
   `Leither mimei provide --mid heWgeGkeBX2gaENbIBS_Iy1mdTS`.
7. Print the release MID and installation directory.

Rerunning the command synchronizes the same release MID again and announces the
provider. It does not create or publish a new app, install the debug app, migrate
user data, or upgrade an existing Leither executable. New-node options are
rejected for existing configurations so they cannot silently change a live node.

The official runtime host currently serves HTTP, including the checksum. This
detects download corruption but does not authenticate the download against
network tampering. This is the same distribution used by the upstream
`install.sh`; its remote shell script is not executed by this package.

If startup, sync, or provide fails, setup exits unsuccessfully and leaves the
node available for inspection. Check the command output and `Leither.log`,
resolve the reported issue, and rerun. The application is not republished or
replaced by a fallback. Runtime downloads use a temporary directory that is
removed after success or failure.

Configure startup after reboot using your service manager and allow the node's
port through your firewall/router. This package starts Leither in the background
but does not create a systemd or launchd service or alter firewall rules.
HLS video support additionally requires both tus-server and FFmpeg; see the
required setup above.

## Package and publish

Build an installable tarball:

```sh
cd packages/dtweet-installer
npm pack
```

Run that package locally without installing dependencies in TweetWeb:

```sh
npm exec --yes --package ./inoku-dtweet-0.1.0.tgz -- dtweet --help
```

The package contains only its launcher, installer, metadata, and this README.
It has no npm install/postinstall hook. Node setup happens only when the user
runs `dtweet`.

The first registry publication requires an authenticated maintainer of the
`@inoku` scope because npm trusted publishing can only be configured after a
package exists. Publish the reviewed tarball with `npm publish <tarball>
--access public --provenance=false` for this initial bootstrap; local publishing
cannot generate GitHub Actions provenance.

Then configure npm trusted publishing for `@inoku/dtweet` using repository
`cfa532/TweetWeb` and workflow `publish-dtweet-installer.yml`, permitting direct
`npm publish`. Keep the package version equal to the intended release tag, then
push an annotated tag such as `dtweet-installer-v0.1.0`. The workflow publishes
that exact tagged source using OIDC and provenance. For a bootstrapped version,
it verifies that the registry integrity matches the tagged package instead of
attempting to overwrite it. Use a new version and tag for every later release.

The public npm install command for this release is:

```sh
npx --yes @inoku/dtweet@0.1.0
```

The npm version pins installer code. Unless `--leither-version` is supplied,
fresh runtime installs use the latest official runtime. Sync always fetches the
published release app for the fixed MID, including newer app publications.
