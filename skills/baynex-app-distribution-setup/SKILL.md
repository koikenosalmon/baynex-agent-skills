---
name: baynex-app-distribution-setup
description: Set up a Flutter app repository for Baynex アプリ配布 using the reusable kit, GCP Workload Identity, Firebase App Distribution, and an Apple Developer Team Key. Use for new app onboarding, an additional Apple account, distribution checks, or CI troubleshooting.
---

# Set up Baynex app distribution

Use `app-distribution/README.md` in this repository as the operator procedure. Work in the app repository and use the kit commands from a checked out `baynex-agent-skills` release. Confirm the GCP project that owns its Firebase apps, GitHub `owner/repo`, Apple account slug, app directory, and each Flutter flavor and target. Do not guess the app pairing when identifiers are ambiguous.

## Owner touch points

1. Ask the owner to sign in to Google when `gcloud` needs authentication. Give them `gcloud auth login --no-launch-browser`; they complete the browser flow and enter the code directly in their terminal. Do not ask them to paste the code in chat.
2. Once per Apple Developer account, ask the owner to create an App Store Connect API **Team Key** with **Admin** access, named `baynex-ci`. Run `add-apple-account.mjs` to create the three empty secrets. Ask the owner to upload the `.p8` file and add Key ID and Issuer ID as new versions through the printed Secret Manager console links. Never request the values in chat.
3. Ask the app team to confirm each `flavor` and `target` marked as unconfirmed in `distribution/apps.json`.

## Procedure

1. Run `node app-distribution/bootstrap.mjs --project <gcp-project> --repo <owner/repo> --apple-account <slug>` in the app repository. For an existing Apple account, use its slug. Inspect the proposed pairs and `distribution/apps.json`. Keep only correctly paired iOS and Android apps.
2. Copy both caller templates into the app repository's `.github/workflows/`. Confirm `permissions: contents: read, id-token: write`, the `config-path`, and the kit release reference. Commit the config and callers.
3. Run the caller check workflow: `gh workflow run app-distribution-check.yml --ref qa -f ensure_bundle_ids=true -f register_devices=false`. Read the Markdown table in the run log or Summary. Verify WIF, the three Apple secret versions, Team ID, bundle IDs, Firebase releases, and UDIDs. Re-run after IAM propagation if necessary. Use `register_devices=true` when the owner wants tester devices registered before the build.
4. Push the app to `qa`. Check Android APK and iOS cloud-signed Ad Hoc build jobs, uploads, and `[baynex]` release notes. Baynex manages tester groups and notifications; do not add Firebase CLI `--testers` or `--groups`.
5. Run `gcloud auth revoke` when finished. Do not print access tokens, put secrets in files under version control, or paste secrets in chat.

If a Firebase release list returns 404, bootstrap and the workflow automatically start App Distribution with the existing invalid probe. If a project cannot be created because of `Cloud billing quota exceeded`, ask the owner to resolve the billing quota; do not silently switch projects.
