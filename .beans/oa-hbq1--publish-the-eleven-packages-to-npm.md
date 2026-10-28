---
# oa-hbq1
title: Publish the eleven packages to npm
status: completed
type: task
priority: normal
created_at: 2026-10-28T15:25:06Z
updated_at: 2026-10-28T19:48:39Z
---

The trusted publishers must name voxslopuli (GitHub Actions, repository openagentsy, workflow publish.yml, no environment) and the publish workflow must publish from a staged copy outside the tree. Both are the human's actions: the trusted publisher is on npm's site and the workflow is a person-only file.



0.2.1 and 0.2.2 are published by hand (all eleven packages, with the author on every one, and the workspace ranges written out as real versions). The last publish was 0.2.2, which also carries the shebang fix: the bin ran under node and died on bun:sqlite, so the published package could not be started at all.

The publish workflow is fixed and it works: it stages each package outside the tree, it names the exact version when it checks the registry, it runs on Node 24, and the 0.2.4 release went through it with OIDC - all eleven packages on npm with the author, the workspace ranges written out as real versions, and the SLSA provenance attestation npm generates for a trusted publish. The trusted publisher is therefore validated, and it no longer expires on 2026-10-30.

All eleven packages carry the trusted publisher that can publish from publish.yml (repository voxslopuli/openagentsy, no environment, with the permissions to publish, to stage and to manage dist-tags). Verified against the registry on 2026-10-28: 11 of 11.

WHAT IS LEFT IS THE WORKFLOW, which is a person-only file (packages/hooks/src/rules.ts PROTECTED_DIRS lists .github/workflows). Two changes:

1. The Publish step must stage each package outside the tree. npm reads the project root's devEngines and refuses to run in a tree whose root asks for another package manager, and this repository root asks for bun. Measured from packages/core as well as from the root: npm resolves the project root to the workspace root, so it refuses either way. The staged copy has no root above it.

2. The step must skip the versions that are already on the registry, because npm refuses to publish over a published version and 0.2.0 is on all eleven.

3. node-version goes from 22 to 24, because npm@latest is now 12.2.1 and it needs node ^22.22.2 or ^24.15.0; the runner's Node 22 is not guaranteed to be 22.22.

THE WHOLE FILE, ready to paste over .github/workflows/publish.yml:

name: publish

# The eleven packages go to npm by hand: the person cutting the release picks
# the tag this workflow already released on GitHub and runs it. Publishing
# needs no npm token: the job presents GitHub's OIDC token, and npm accepts
# it because every package lists this workflow as a trusted publisher. That
# config lives on each package's npmjs.com page and names the repository
# (voxslopuli/openagentsy), the workflow filename (publish.yml) and no
# environment, so the three have to keep matching; all eleven carry it,
# with the permissions to publish, to stage and to manage dist-tags.
# npm CLI 11.5.1 or newer is required for trusted publishing, which is why
# the job installs Node 24 and upgrades npm even though the repository is
# Bun.
on:
  workflow_dispatch:
    inputs:
      tag:
        description: "The tag whose version is published, for example v0.1.0."
        required: true
        type: string

concurrency:
  group: publish-${{ github.event.inputs.tag }}

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.inputs.tag }}
          fetch-depth: 0

      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version-file: package.json

      # The publish step runs the npm CLI, not bun: trusted publishing speaks
      # OIDC through npm 11.5.1 or newer.
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"

      - name: Install
        run: bun install --frozen-lockfile

      - name: Build
        run: bun run build

      - name: The tag matches every manifest
        env:
          TAG: ${{ github.event.inputs.tag }}
        run: |
          version="${TAG#v}"
          for package in packages/core packages/models packages/footprint packages/quality packages/tasks packages/memory packages/ledger packages/hooks packages/jev packages/mcp packages/cli; do
            manifest="$(bun -e "console.log(require('./$package/package.json').version)")"
            if [ "$manifest" != "$version" ]; then
              echo "::error::$package is at $manifest but the tag says $version"
              exit 1
            fi
          done

      - name: Upgrade npm for trusted publishing
        run: npm install -g npm@latest

      # The publish order is the dependency order: a package is published
      # after everything it depends on, so an install never sees a version
      # that points at a version that is not on the registry yet.
      #
      # The publish runs from a copy outside the tree. npm reads the
      # project root's devEngines and refuses to run in a tree whose root
      # asks for another package manager, and the root of this repository
      # asks for bun - measured from a package directory too, because npm
      # resolves the project root to the workspace root. The staged copy has
      # no root above it, so npm has nothing to refuse, and its manifest
      # carries the versions the workspace protocol named.
      - name: Publish
        run: |
          # Public scope, public access, provenance comes with the OIDC
          # publish by itself: the flag is not needed and no token is set -
          # a leftover NPM_TOKEN or NODE_AUTH_TOKEN would win over OIDC.
          for package in packages/core packages/models packages/footprint packages/quality packages/tasks packages/memory packages/ledger packages/hooks packages/jev packages/mcp packages/cli; do
            name="$(bun -e "console.log(require('./$package/package.json').name)")"
            version="$(bun -e "console.log(require('./$package/package.json').version)")"
            echo "::group::publishing $name@$version"
            if npm view "$name" "$version" version >/dev/null 2>&1; then
              echo "$name@$version is already on the registry"
              echo "::endgroup::"
              continue
            fi
            stage="$RUNNER_TEMP/publish/$name"
            bun scripts/stage-package.mjs "$package" "$stage"
            (cd "$stage" && npm publish --access public)
            echo "::endgroup::"
          done

TWO PERSON-ONLY ACTIONS REMAIN.

1. The trusted publisher on npmjs.com, for each of the eleven packages: provider GitHub Actions, organization voxslopuli, repository openagentsy, workflow filename publish.yml, environment empty. The packages: @voxslopuli/openagentsy, @openagentsy/core, @openagentsy/models, @openagentsy/footprint, @openagentsy/quality, @openagentsy/tasks, @openagentsy/memory, @openagentsy/ledger, @openagentsy/hooks, @openagentsy/jev, @openagentsy/mcp. The three that already existed (core, models, mcp) have a trusted publisher naming selfagency: change the organization. The other eight need one created.

2. The publish workflow, which is a person-only file (packages/hooks/src/rules.ts PROTECTED_DIRS lists .github/workflows). The Publish step must stage each package outside the tree, because npm refuses to run in a tree whose nearest manifest has devEngines asking for another package manager and this repository root asks for bun. The replacement step body:

      - name: Publish
        run: |
          # Public scope, public access, provenance comes with the OIDC
          # publish by itself: the flag is not needed and no token is set -
          # a leftover NPM_TOKEN or NODE_AUTH_TOKEN would win over OIDC.
          for package in packages/core packages/models packages/footprint packages/quality packages/tasks packages/memory packages/ledger packages/hooks packages/jev packages/mcp packages/cli; do
            name="$(bun -e "console.log(require('./$package/package.json').name)")"
            version="$(bun -e "console.log(require('./$package/package.json').version)")"
            echo "::group::publishing $name@$version"
            if npm view "$name" "$version" version >/dev/null 2>&1; then
              echo "$name@$version is already on the registry"
              echo "::endgroup::"
              continue
            fi
            stage="$RUNNER_TEMP/publish/$name"
            bun scripts/stage-package.mjs "$package" "$stage"
            (cd "$stage" && npm publish --access public)
            echo "::endgroup::"
          done

The stage step is scripts/stage-package.mjs, which copies the package and writes the workspace: ranges out as the versions they name. The skip is there because 0.2.0 is already on the registry for all eleven packages, and npm refuses to publish over a version.



## Summary of Changes

- The eleven packages are published at 0.2.4 through the publish workflow, with OIDC, and every one carries the author, the real dependency ranges and the provenance attestation.
- The publish workflow stages each package outside the tree (npm refuses to run in this tree, and npm does not rewrite the workspace: ranges, so a package published from the tree cannot be installed), names the exact version when it checks the registry, and runs on Node 24.
- The old unscoped openagentsy package is deprecated on every version with the message that it moved to @voxslopuli/openagentsy.
- The CLI's bin runs on bun (the board is bun:sqlite), which is what made the published package startable at all.

