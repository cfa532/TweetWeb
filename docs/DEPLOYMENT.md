# TweetWeb Publication and Deployment

This is the canonical production release procedure for TweetWeb. A release is
complete only after the same `dist` build has been published to both targets:

1. the Leither `tweet1` app on gen8; and
2. the `dtweet-deeplink` Cloudflare Worker asset binding.

Publishing only one target leaves the other target serving the previous web
application.

## Prerequisites

- Run the commands from the `TweetWeb` repository unless a step says otherwise.
- Ensure `ssh gen8` and `scp ... gen8:...` work.
- Ensure Wrangler is authenticated for the `dtweet.com` Cloudflare account.
- Keep the sibling `TweetBackendApp` repository next to `TweetWeb`; backend
  MApp scripts are copied from there when a release includes backend changes.
- Keep the sibling `Tweet-iOS` repository next to `TweetWeb`; the Worker lives
  at `../Tweet-iOS/cloudflare/dtweet-worker` and reads this repository's `dist`
  directory.

## 1. Select the Production Node Configuration

`VITE_LEITHER_NODE` is a local testing override. Before building for
production, comment every active `VITE_LEITHER_NODE` assignment in `.env`:

```dotenv
#VITE_LEITHER_NODE=192.168.99.1:8002       #gen8
```

Do not commit an `.env` change made only for a release. Record the original
local value so it can be restored after verification.

## 2. Publish Backend Changes First (When Applicable)

Pushing or committing `TweetBackendApp` does not update the Leither app. If the
release includes changed backend MApp JavaScript, copy the committed versions
of those files into the existing `tweet1` package before building or deploying
TweetWeb. Copy only the changed backend files; do not replace the whole
`tweet1` directory because it also contains production web assets and release
artifacts.

For example, repeat the source-file argument for every changed backend entry:

```bash
scp \
  ../TweetBackendApp/changed-entry-1.js \
  ../TweetBackendApp/changed-entry-2.js \
  gen8:/home/pi/demo/tweet1/
```

Compare the local and remote file hashes, then publish the backend changes:

```bash
shasum -a 256 ../TweetBackendApp/changed-entry-1.js
ssh gen8 'shasum -a 256 /home/pi/demo/tweet1/changed-entry-1.js'
ssh gen8 'cd /home/pi/demo && ./tweet1.sh'
```

The command must finish with `APP published successfully`. Complete this
backend publication before continuing with the TweetWeb build. When the same
release changes both projects, `tweet1.sh` is therefore run twice: once after
copying backend scripts and again after copying the web `dist` files.

## 3. Build Once

```bash
npm run build
```

This runs the TypeScript check and creates the production package in `dist`.
Do not rebuild between the two publication targets; both must receive the same
output.

## 4. Publish the Leither App

Copy the generated entry files and static dependencies into the `tweet1`
package on gen8:

```bash
scp \
  dist/bootstrap.min.js \
  dist/gtag.js \
  dist/hprose.js \
  dist/ic_splash.png \
  dist/index.html \
  dist/index_entry.js \
  dist/popper.min.js \
  gen8:/home/pi/demo/tweet1/
```

Publish the package with the existing server-side script:

```bash
ssh gen8 'cd /home/pi/demo && ./tweet1.sh'
```

The command must finish with `APP published successfully` and report a new
backup/version number.

## 5. Deploy the Cloudflare Worker and Assets

The Worker configuration reads `TweetWeb/dist` directly. From its directory,
deploy the Worker and the same build assets:

```bash
cd ../Tweet-iOS/cloudflare/dtweet-worker
npx wrangler deploy
```

Confirm Wrangler reports a new version and all production routes:

- `dtweet.com`
- `www.dtweet.com`
- `dl.dtweet.com/*`

## 6. Verify Production

From the `TweetWeb` repository, compare the local JavaScript bundle with every
public hostname:

```bash
shasum -a 256 dist/index_entry.js
curl -fsSL https://dtweet.com/index_entry.js | shasum -a 256
curl -fsSL https://www.dtweet.com/index_entry.js | shasum -a 256
curl -fsSL https://dl.dtweet.com/index_entry.js | shasum -a 256
```

All four SHA-256 values must match. If an edge temporarily serves an older
asset, wait for propagation and repeat the direct checks; a query string alone
is not proof that the cached bundle changed.

Also open a production `/tweet/<tweet-id>/<author-id>` URL and confirm that the
page loads the current bundle.

## 7. Restore Local Testing Configuration

After verification, restore the developer's original `.env` value when local
testing requires a fixed node:

```dotenv
VITE_LEITHER_NODE=192.168.99.1:8002       #gen8
```

Restoring `.env` does not alter the already-built or deployed production
assets.

## Release Checklist

- [ ] Production build has no active `VITE_LEITHER_NODE` override.
- [ ] If `TweetBackendApp` changed, its committed JavaScript files were copied,
      hash-checked, and published on gen8 before the TweetWeb build.
- [ ] `npm run build` completed successfully.
- [ ] The seven generated assets were copied to gen8.
- [ ] `tweet1.sh` published a new Leither app version.
- [ ] Wrangler deployed a new Worker version with all three routes.
- [ ] Public asset hashes match `dist/index_entry.js`.
- [ ] A production tweet link loads successfully.
- [ ] The developer's original local `.env` value was restored.
