# TweetWeb Publication and Deployment

This is the canonical release procedure for TweetWeb. Build once, upload the
web assets and all current production Go sources to gen8, publish with
`tweet1.sh`, and deploy that same web build to Cloudflare unless the user
explicitly defers Cloudflare.

After the requested publication commands finish, perform **one HTTP GET
availability check** against the release site's root URL. No other verification
is part of a routine release. Do not run tests, hash comparisons, remote source
inventories, numbered/`last` probes, backend health or provider checks, browser
verification, asset inspections, association-file checks, or separate Cloudflare
checks unless explicitly requested.

The availability check establishes only that the site responds with HTTP 200;
it does not establish bundle freshness or application behavior. Required build,
upload, and publication commands must succeed. Stop and address a reported
failure rather than describing the publication as successful.

For domain or routing changes, use the separate
[Browser Fallback Domain Migration Memo](BROWSER_FALLBACK_DOMAIN_MIGRATION.md).
Its migration diagnostics are not routine release steps.

## Prerequisites

- Run local commands from `TweetWeb` unless a step says otherwise.
- Keep the sibling `TweetBackendApp` repository available; its production Go
  sources are required for every release, including web-only changes.
- Keep the sibling `Tweet-iOS` repository available when publishing Cloudflare.
  The Worker lives at `../Tweet-iOS/cloudflare/dtweet-worker` and reads `dist`.
- Use the existing gen8 publication scripts. Leave Leither's own files, including
  `temp.html`, unchanged.

Before connecting to gen8, resolve its current public IP:

```bash
nslookup gen8.leither.uk
GEN8_IP='replace-with-freshly-resolved-IP'
```

Use that freshly resolved IP for SSH/SCP on port 220, with
`HostKeyAlias=[gen8.leither.uk]:220` to retain host-key verification. Do not reuse
an IP from an earlier session or save it as permanent configuration.

## 1. Select the Publication Environment

The `.env` file contains release and debug values. Use the release AppID and
followings for a release, with every `VITE_LEITHER_NODE` assignment commented
out. A fixed local node must never be embedded in a published build.

| Environment | AppID | Default followings | Target | Publisher |
| --- | --- | --- | --- | --- |
| Release | `heWgeGkeBX2gaENbIBS_Iy1mdTS` | `mKOihoVuFnQ2xt33R51KTQXSBkX` | `/home/pi/demo/tweet1/` | `tweet1.sh` |
| Debug | `d4lRyhABgqOnqY4bURSm_T-4FZ4` | `6IQc_t22JUub1TEgDP9Fo_Boosm` | `/home/pi/demo/twbe/` | `twbe.sh` |

Environment overrides may select the build without editing `.env`. If `.env`
is changed for publication, record its original contents and restore them at
the end. Do not commit publication-only environment changes.

## 2. Prepare the Backend Sources

Every release includes the current production `.go` sources from the root of
`TweetBackendApp`. Exclude `*_test.go`, module files, documentation, local tooling,
and signing keys. Both release and debug use this File-capable Go backend;
`legacy-js/` is not a publication source.

Back up the existing package outside its application directory before uploading.
Preserve existing download assets and browser dependencies. Do not replace an
entire package with another project's directory. Superseded source files must be
removed when a change explicitly replaces them; do not add a separate remote
inventory or hash audit to the release procedure.

The Go runtime details are maintained in `TweetBackendApp/README.md`.

## 3. Build Once

With the release environment selected and no fixed node configured:

```bash
npm run build
```

The build includes TypeScript compilation checks and writes the release assets to
`dist`. Do not run tests or separate checks. Keep this exact `dist` output for
both gen8 and Cloudflare, including when Cloudflare publication is deferred.

Debug builds must use their own AppID and followings and a separate output
folder so they do not overwrite a release waiting for Cloudflare. The extra
`--` below forwards Vite's output-folder option through the build script:

```bash
VITE_MIMEI_APPID=d4lRyhABgqOnqY4bURSm_T-4FZ4 \
VITE_DEFAULT_FOLLOWINGS=6IQc_t22JUub1TEgDP9Fo_Boosm \
VITE_LEITHER_NODE= \
npm run build -- -- --outDir /private/tmp/tweetweb-debug-dist
```

## 4. Publish the Leither App

For a release, first back up `tweet1` outside the package directory:

```bash
ssh -p 220 -o 'HostKeyAlias=[gen8.leither.uk]:220' "pi@$GEN8_IP" 'set -e
backup_dir=$(mktemp -d /home/pi/demo/tweet1-before-release.XXXXXX)
cp -a /home/pi/demo/tweet1 "$backup_dir/"'
```

Upload all production backend Go sources and the seven web assets:

```bash
rsync -av -e 'ssh -p 220 -o HostKeyAlias=[gen8.leither.uk]:220' \
  --exclude='*_test.go' --include='*.go' --exclude='*' \
  ../TweetBackendApp/ "pi@$GEN8_IP:/home/pi/demo/tweet1/"
scp -P 220 -o 'HostKeyAlias=[gen8.leither.uk]:220' \
  dist/bootstrap.min.js \
  dist/gtag.js \
  dist/hprose.js \
  dist/ic_splash.png \
  dist/index.html \
  dist/index_entry.js \
  dist/popper.min.js \
  "pi@$GEN8_IP:/home/pi/demo/tweet1/"
```

After both uploads succeed, publish once with the existing script:

```bash
ssh -p 220 -o 'HostKeyAlias=[gen8.leither.uk]:220' "pi@$GEN8_IP" \
  'cd /home/pi/demo && bash -e ./tweet1.sh'
```

Use the command's exit status and publication output to report the result and
new version. `bash -e` stops the publisher if a command fails. Publisher output
can contain signing material: capture it privately and report only the needed
success/error information and version number. Do not paste unfiltered logs.
Do not follow publication with API, version, source, asset, or provider probes.

For debug publication, back up and upload to `/home/pi/demo/twbe/`, use the saved
debug web assets, and run `bash -e ./twbe.sh` from `/home/pi/demo`. Do not deploy
debug to Cloudflare or run separate debug verification unless requested.

## 5. Deploy the Cloudflare Worker and Assets (Release Only)

Unless the user explicitly defers Cloudflare, publish the same release build:

```bash
cd ../Tweet-iOS/cloudflare/dtweet-worker
npx wrangler deploy
```

The Worker's `ASSETS` binding reads `TweetWeb/dist`. Do not rebuild between the
gen8 and Cloudflare publications. Use Wrangler's command result to report
success or failure; do not add configuration, route, asset, or provider checks.

When Cloudflare is deferred, skip this step, keep the release `dist` available,
and state in the handoff that only gen8 was updated. Do not deploy Cloudflare
as an unrequested follow-up.

The Worker owns redirects from `dtweet.com` and `www.dtweet.com`, as well as
HTTPS handling for `dl.dtweet.com`. Its `BROWSER_FALLBACK_ORIGIN` in
`src/index.js` identifies the release browser site. A routine publication does
not change domain bindings, nginx configuration, or redirect rules.

## 6. Check Site Availability Once

After all requested publication commands succeed, make one GET to the release
site's root. Use `BROWSER_FALLBACK_ORIGIN` from the Worker source as the URL;
it is currently `http://t1.www33.shop`:

```bash
RELEASE_SITE_URL='http://t1.www33.shop'
curl --fail --silent --show-error --location \
  --connect-timeout 10 --max-time 30 \
  --header 'Accept: text/html' \
  --output /dev/null --write-out 'Site availability: HTTP %{http_code}\n' \
  "$RELEASE_SITE_URL/"
```

Require a successful command and final HTTP 200. A timeout, request failure, or
other final status is a failed availability check: report and address the
reported failure. Do not automatically broaden it into other checks, repeated
probes, or a browser session. Following a redirect within this single check is
allowed. If it succeeds, there are no further release verification steps.

## 7. Restore Local Testing Configuration

Restore any local environment settings changed for publication. This does not
alter already-built or published assets. Leave the release `dist` intact if
Cloudflare publication is pending.

## Publication Checklist

- [ ] Release environment selected; no fixed node embedded in the build.
- [ ] gen8 freshly resolved; required `HostKeyAlias` used for connections.
- [ ] Existing gen8 package backed up outside its application directory.
- [ ] `npm run build` succeeded.
- [ ] Current production Go sources and all seven release web assets uploaded.
- [ ] `bash -e ./tweet1.sh` succeeded; publication version recorded from its output.
- [ ] Same `dist` published to Cloudflare, or Cloudflare explicitly deferred.
- [ ] One site-root HTTP availability check succeeded with HTTP 200.
- [ ] Any temporary local environment changes restored.

## av1 nginx domain-routing invariant

Domain, proxy, certificate, and redirect changes belong to the separate
[Browser Fallback Domain Migration Memo](BROWSER_FALLBACK_DOMAIN_MIGRATION.md).
Preserve the existing browser, native-client, Fireshare, and LifeDrive routes
when doing that work. Their migration-specific diagnostics are outside the
routine release procedure above.

The following incident records are background context. Their diagnostic commands
are not release steps and must not be run as extra publication verification.

## Deferred Issue: App Busy During Account Migration (2026-10-30)

**Decision:** Prioritize the Leither developer's fix for the App busy / bounded
MApp execution issue. Defer further migration recovery redesign until that issue
has been investigated. This is an unresolved issue, not a completed fix.

### Observed behavior

The user reported that a TweetWeb migration failed on the first attempt and
succeeded on a manual retry. TweetWeb displayed the failure and retry guidance
correctly. The destination logged:

```text
10:31:49 [mapp][E] Tweed Error sync_user: MiMeiSync(uNQJBPk5SPnHIwkJm5T0Getbf_g): mapp call bounded: node is still working for this app, request={"aid":"d4lRyhABgqOnqY4bURSm_T-4FZ4","author":"5lrADJpzRpYZ82-6jkewoa1w3jB","hostid":"ReyCUFHHZmk0N5w_wxUeEuoY5Xr","mid":"uNQJBPk5SPnHIwkJm5T0Getbf_g","migrate":"true","src":"user","ver":"last","version":"v2","via":"hprose"}
```

The request identifies the debug app and uses `last`; the exact numbered version
is not in the log. At this point, release 1456 and debug 1691 had been published.
The error does not establish which other operation was still active or whether
that operation later completed. The Leither developer should investigate the
busy condition before clients add workarounds for it.

### Remaining migration risk

- The origin saves and publishes the destination as `hostIds[0]` before the
  destination's `sync_user` succeeds. A destination failure does not revert that
  origin update. Migration save and sync requests each have a 60-second timeout.
- A manual retry can complete the migration. There is no durable pending-migration
  record or login-time resume step. Logout or browser closure can therefore leave
  an incomplete migration without retaining the current retry context.
- Login may still authenticate through the origin or another provider, but it
  does not finish migration. Subsequent writes target the destination and may fail
  if its account copy is missing or incomplete. Background replication is not a
  verified completion mechanism for this case.

Keep this risk recorded even after the busy issue is fixed: interrupted migration
can also result from network failure or client closure. Revisit preparing the
destination before changing ownership and durable recovery across sessions when
migration work resumes. Do not add automatic rollback, hidden retries, or IP/port
substitution as an interim workaround.

Relevant code: TweetWeb `src/stores/tweetStore.ts` (`updateProfile`, `login`,
`logout`); TweetBackendApp `profile_entries.go` (`entrySetAuthorCoreData`) and
`user_entries.go` (`entrySyncUser`, `entryLogin`).

## Operational Incident: av1 Memory Exhaustion (2026-09-19)

All times below are UTC+8. `http://t1.fireshare.us/` stopped responding;
av1 was unreachable over HTTP, public SSH, and its Tailscale address. The
Leither backend on gen8 still returned HTTP 200 when queried locally with
`Host: t1.fireshare.us`. The user rebooted av1 at approximately 20:52, restoring
SSH and public HTTP service.

### Evidence and cause

Previous-boot records in `/var/log/kern.log`, `/var/log/syslog`, the systemd
journal, and `/var/log/sysstat/sa19` showed severe memory pressure:

- At 16:19, Linux killed `fwupd` for memory exhaustion.
- At 17:21, the scheduled `fwupd-refresh.service` started the firmware updater
  again. Memory-pressure warnings followed at 17:22.
- At 19:20, the one-minute load average reached 122.65 on two CPUs. Linux
  killed the root user-session systemd process and `fwupd`; journald and
  snapd hit watchdog timeouts. The previous boot's logs ended at 19:20:43.
- Earlier out-of-memory events had killed Leither on September 14–18, so this
  was a recurring capacity problem rather than an isolated web release failure.

av1 had 894 MiB of usable RAM and an active 4 GiB swap file. Kernel dumps and
historical metrics showed that all swap remained unused during the failures.
`/etc/sysctl.conf` explicitly set `vm.swappiness = 0`; the active TuneD
`virtual-guest` profile specified 30, but TuneD's `reapply_sysctl = 1` reapplied
the conflicting system override afterward. `/etc/sysctl.d/99-sysctl.conf`
was a symlink to `/etc/sysctl.conf`. The inspected service cgroups did not
restrict swap.

Memory exhaustion is confirmed; the firmware refresh appears to have triggered
the final episode. Zero swappiness strongly delays swapping rather than
disabling it outright; see the
[kernel swappiness documentation](https://kernel.org/doc/html/latest/admin-guide/sysctl/vm.html#swappiness).
The logs do not establish an application memory leak.

### Resolution and verification

At 21:31, the following correction was applied on av1:

1. Backed up `/etc/sysctl.conf` to
   `/root/sysctl.conf.before-swappiness.GgnUhq`.
2. Removed only the `vm.swappiness = 0` line from `/etc/sysctl.conf`.
3. Applied `sysctl -w vm.swappiness=30` for the running system. The enabled
   TuneD service and its existing `virtual-guest` profile provide the persistent
   setting; no additional override was added.

At 21:32, the live value was still 30, `tuned`, `nginx`, and `leither` were
active, and both the local nginx route and the public URL returned HTTP 200.
No additional reboot, application deployment, or firmware-service change was
needed. These checks confirm the configuration and immediate availability;
long-term recurrence prevention and persistence across a later reboot have
not yet been observed.

For a subsequent read-only check:

```bash
ssh root@av1 'sysctl vm.swappiness; cat /etc/tuned/active_profile; systemctl is-enabled tuned; systemctl is-active tuned nginx leither; free -h'
curl -I --max-time 20 http://t1.fireshare.us/
```

Expected: swappiness 30, profile `virtual-guest`, TuneD enabled, all three
services active, and HTTP 200. Swap need not be used while memory is available.
If memory exhaustion recurs, inspect new kernel events and per-process memory
before choosing further changes; the host still has less than 1 GiB of RAM.
