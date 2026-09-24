# Releasing

## 1. Bump the version

```bash
git checkout master
git pull
npm version 2.0.1 --no-git-tag-version
git commit -am "Release v2.0.1"
git push
```

## 2. Publish the GitHub release

1. Go to **Releases → Draft a new release**.
2. **Choose a tag:** type `2.0.1` and pick "Create new tag: 2.0.1 on publish". Target `master`.
3. **Title:** `v2.0.1`. Add release notes.
4. Click **Publish release**.

Publishing the release triggers the Release workflow, which publishes the package to npm.
