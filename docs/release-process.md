# Private release process

Only the owner publishes. This process never merges the feature branch, changes repository visibility, invites users, rewrites tags or overwrites a release. Keep the task PR draft. The first beta is `0.1.0-beta.1`.

## Verify and commit

1. Confirm `gh repo view koraybostanci/herdr-workspace --json isPrivate` is true, and use the repository's approved personal Git/GitHub identity.
2. Update matching versions in `package.json`, `package-lock.json` and `bundle.json`. Refresh runtime hashes with `node scripts/update-bundle.mjs`.
3. Run `npm ci --ignore-scripts`, `npm ci --ignore-scripts --prefix integrations/session-metadata`, `npm test`, `npm run check:privacy`, `npm run test:clean-install` and `npm run test:native-install`. Native validation needs macOS and the actual tested Herdr binary/resources. Custom sources use `-- --host-home DIR --herdr-bin BINARY`.
4. Inspect the scoped diff, notices, docs and sanitized test output. Commit and push the tested feature commit. Keep the PR draft and leave merging to the user.

## Build and inspect

Use a new output directory outside the checkout. The builder refuses dirty trees and mismatched versions. It compares every selected file's bytes and executable mode against actual Git blobs at HEAD; ignored or uncommitted files inside recursive resources cannot enter the release.

```sh
npm run release:build -- --output /path/to/new-artifacts
npm run release:verify -- --directory /path/to/new-artifacts
```

The trio is `herdr-workspace-VERSION.tar.gz`, `herdr-workspace-VERSION.manifest.json`, and `SHA256SUMS`. Embedded `RELEASE.json` equals the standalone manifest. It records normalized file modes, hashes, repository and source commit. The deterministic archive excludes Git metadata, credentials, local state and `node_modules`. Symlinks, unsafe paths, unsupported archive formats and incomplete imports are rejected. SHA-256 is an integrity check, not an independent signature.

Review archive membership and documentation links. The verifier is deliberately limited to this normalized USTAR/gzip format, with 64 MiB compressed/decompressed limits, 8 MiB per file and at most 8,192 payload files.

## Plan, then publish privately

```sh
npm run release:private -- --directory /path/to/new-artifacts
npm run release:private -- --directory /path/to/new-artifacts --publish
```

Without `--publish`, this is read-only planning. Publication binds the archive's exact inventory, bytes and modes to the tested source and committed Git blobs, not just its commit label. It also verifies private visibility, version agreement, a clean checkout, remote commit access and any existing tag. Existing drafts or published releases and conflicting tags block it. It runs all dependency/test/privacy/clean/native gates and repeats the source binding before GitHub writes.

The publisher creates a draft prerelease for the exact SHA. It downloads all three uploaded assets, compares their bytes, verifies the archive again, and checks privacy before publishing. It never marks the release latest. It checks private visibility and release/tag metadata afterward. A failed draft verification leaves remote artifacts for owner inspection; nothing is automatically deleted or overwritten. If the version already exists, investigate manually rather than reusing or moving it.

GitHub credentials remain in the owner's CLI environment, never in artifacts or notes. Use your own authorized account. Visibility checks detect a change; they are not an atomic lock against an administrator changing visibility concurrently. No second-Mac success may be claimed until the [external checklist](private-beta.md#external-mac-acceptance-checklist) is actually complete.
