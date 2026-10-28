---
# oa-hbq1
title: Publish the eleven packages to npm
status: todo
type: task
priority: normal
created_at: 2026-10-28T15:25:06Z
updated_at: 2026-10-28T17:10:25Z
---

The trusted publishers must name voxslopuli (GitHub Actions, repository openagentsy, workflow publish.yml, no environment) and the publish workflow must publish from a staged copy outside the tree. Both are the human's actions: the trusted publisher is on npm's site and the workflow is a person-only file.



All eleven packages are published at 0.2.0 by hand (the OIDC path needs the trusted publishers, which only a person can create). The ten libraries carry the author Grand Slopulissimo; the main package @voxslopuli/openagentsy was published before the author landed in the manifests, so its registry record has no author - it needs a 0.2.1 republish with the author.

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
