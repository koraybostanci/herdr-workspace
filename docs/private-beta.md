# Private beta

`v0.1.0-beta.1` targets macOS, Herdr 0.1.12 and Node 26+. The repository and release remain private. Only accounts already authorized to read the repository can download the release. Do not share tokens, make the repository public or treat a failed download as a reason to weaken access controls.

## Authenticated download

Install GitHub CLI and sign in with your own authorized account. Check `gh auth status` and `gh repo view koraybostanci/herdr-workspace`. A 404 can mean missing repository access. Ask the owner for access through your normal channel; the installer does not invite people or change permissions.

In a new empty folder:

```sh
gh release download v0.1.0-beta.1 --repo koraybostanci/herdr-workspace
shasum -a 256 -c SHA256SUMS
```

Both checksum lines must report `OK`. Stop on any mismatch. Checksums detect changed bytes; they are not an independent signature. Trust the authenticated release source and compare the source commit in its notes and manifest.

For the stricter archive-structure and embedded-file check before extraction, use a separate authenticated clone of the exact tag. The verifier needs Node but no npm dependencies:

```sh
gh repo clone koraybostanci/herdr-workspace ../herdr-workspace-verifier -- --branch v0.1.0-beta.1 --depth 1
node ../herdr-workspace-verifier/scripts/verify-release.mjs --directory .
```

The download directory must contain the release trio only. Keep the verifier checkout beside it, as above. The source checkout can be retained for auditing; install from the verified archive below.

After verification:

```sh
tar -xzf herdr-workspace-0.1.0-beta.1.tar.gz
cd herdr-workspace-0.1.0-beta.1
npm ci --ignore-scripts
node bin/herdr-workspace.mjs plan
node bin/herdr-workspace.mjs install
node bin/herdr-workspace.mjs doctor
herdr-app do layout.switch '{"name":"herdr-workspace"}'
```

Run one command at a time. Stop on blockers. Install never selects the layout. Harness configuration is optional: use matching `--configure-harnesses opencode,claude` options on `plan` and `install`, selecting only harnesses you use. Preserve custom path options. See [installation](installation.md) for upgrade, adoption and removal.

## What has been checked

- Automated installer, compatibility, source privacy, legal-notice, archive-integrity and publisher-safety tests.
- Clean source-export install/repeat/doctor/removal using a synthetic host. This is not a native-runtime check.
- A separate isolated-profile gate uses the actual Herdr binary and public built-in resources. It checks four mods and a populated tree/History render, synthetic managed upgrade, settings preservation and removal. It never launches the app window or connects to the personal core.
- Earlier live UI checks used the developer's existing desktop. They do not establish second-machine acceptance or automated pointer/pixel coverage.

The release publisher requires all automated and local native gates to pass. The release manifest names the exact source commit. Root and installed-mod notices are included; dependencies and Herdr binaries are not vendored. The Claude SDK remains under its separate terms.

## External-Mac acceptance checklist

**Status: pending. No second physical Mac has been tested here.** An authorized tester should complete this on another Mac before broad sharing:

1. Record macOS, CPU architecture, Herdr, Node and beta version/source commit. Do not include usernames, home paths, tokens or session titles in the report.
2. Download through your own account. Verify checksums and archive inventory. Confirm the repository is still private.
3. On a disposable user/profile, install with no harness flag. Confirm the preview writes nothing and unrelated harness settings remain byte-identical.
4. Confirm `doctor` succeeds and `herdr-app check` loads each of the four installed mods. Save only sanitized errors.
5. Select the layout manually. Open multiple Spaces in Agents and History independently; search across History; resize/collapse/reopen History; relaunch normally and check remembered sizing. Check native window buttons, rows, menus, right-click and same-machine reorder.
6. If desired, opt into your chosen harness adapters with matching plan/install flags. Confirm unrelated JSONC comments, plugins, hooks, providers and credential helpers remain intact. Confirm exact-session History opens without creating a replacement conversation.
7. Re-run install and confirm no changes. If an earlier managed release is available, upgrade from it using the same paths. The local automated upgrade uses a synthetic predecessor, not a certified historical beta.
8. Switch to another layout and uninstall. Confirm unchanged owned files/settings are removed or adopted originals restored; edited files, unrelated settings and private history/state remain.
9. Report pass/fail per step and any sanitizer-safe error. Do not send private catalogs, journals, transcripts or whole settings files. A failed step blocks acceptance; do not bypass it with `--adopt` unless the conflict has been deliberately reviewed.
