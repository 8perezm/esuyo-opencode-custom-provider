# Publishing

How `@esuyo/esuyo-opencode-custom-provider` gets to npm.

## Trigger

Push to `main`/`master` runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) (also `workflow_dispatch`).

It requires `NPM_TOKEN` secret (granular token with `write` to `@esuyo` org).

## What CI does

1. `actions/checkout@v6` + `setup-node@v6` (Node 22, `registry-url: https://registry.npmjs.org`, `id-token: write`)
2. `npm ci` → `npm run build` (`tsc`) → `npm run typecheck`
3. **Determine bump** from last commit message (`src:publish.yml:48`):
   - `BREAKING CHANGE:` or `^major:` → `major`
   - `^feat:` or `^feature:` or `^minor:` → `minor`
   - else → `patch`
4. `npm version $BUMP --no-git-tag-version` (updates `package.json` + `package-lock.json`)
5. Commit `chore: bump version to x.y.z [skip ci]` + `git push`
6. `git tag vX.Y.Z` + `git push origin vX.Y.Z`
7. `npm publish --access public` (`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`) — **no `--provenance`** (removed to match `8perezm` GitHub remote vs `Esuyo` npm org; `package.json:repository.url` is `git+https://github.com/8perezm/...`)
8. `gh release create vX.Y.Z`

## Versioning

We use conventional commits:

```bash
git commit -m "feat: add global fallback"           # -> minor 0.3.0 → 0.4.0
git commit -m "fix: handle timeout"                 # -> patch
git commit -m "docs: update README"                # -> patch (no feat)
git commit -m "feat: new api

BREAKING CHANGE: rename provider"                   # -> major
```

## Scoped package

`package.json:name` is `@esuyo/esuyo-opencode-custom-provider` (scoped to Esuyo npm org). Previous unscoped `esuyo-opencode-custom-provider@0.2.4` is deprecated — `npm deprecate esuyo-opencode-custom-provider@"<=0.2.4" "Moved to @esuyo/esuyo-opencode-custom-provider"` if needed.

## Manual publish (rare)

```bash
npm run build
npm version patch --no-git-tag-version
npm publish --access public
git add package.json package-lock.json
git commit -m "chore: bump version to x.y.z [skip ci]"
git tag vX.Y.Z && git push origin main --tags
```

## Troubleshooting

- `422 provenance` → ensure `publish.yml` does **not** use `--provenance` or fix `package.json:repository.url` to match GitHub remote.
- `403` → `NPM_TOKEN` missing/expired or not in `@esuyo` org.
- Cache not updating for users → they need `opencode plugin @esuyo/esuyo-opencode-custom-provider --global --force` or `rm -rf ~/.cache/opencode/packages`.
