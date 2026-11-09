# Instructions for coding agents

Wayfinder lets people explore OpenStreetMap data for any country on their own machine. The README covers what it does and how to run it.

## Setup

```sh
npm install
npm run setup
npm run analytics:setup
```

The last command builds Luxembourg. Real-data tests and the feature walkthrough need it.

## Before every push to GitHub

Work through these steps in order, every time. If a step fails, fix the problem or tell the user. Never push with a failing or skipped step without telling the user first.

### 1. Test every feature

```sh
npm run build
npm test
npm run test:visual
npm run screenshots
```

| Command | What it checks | Required result |
|---|---|---|
| `npm test` | Unit, smoke, integration and regression tests | No failures and nothing skipped |
| `npm run test:visual` | Layout and behaviour against saved images | All pass. Its baselines are macOS only, so on other systems say that it was not run |
| `npm run screenshots` | Uses every feature in Chrome on real data | `Every feature passed.` |

The walkthrough covers the map, tag filters, combined tags, regions, object details, Go to location, nearby search, the table and CSV export, region comparison, Freshness, satellite imagery and the Countries page.

If you add a feature, add it to `features` in `code/tests/screenshots/capture.mjs`, and give it a section and image in the README. If you remove one, remove both.

If port 5199 is busy, run the visual tests with `VISUAL_PORT` set to a free port. After an intended visual change, refresh the baselines with `npx playwright test --update-snapshots`, and look at what changed before keeping them.

### 2. Check whether the UI or screenshots changed

`npm run screenshots` has just rewritten the images in `docs/screenshots`. Compare the code with what is on GitHub:

```sh
git fetch https://github.com/raajahuja/OSMAnalytics.git main
git diff --name-only FETCH_HEAD -- code/web code/server code/pipeline
```

- **If that lists any files,** the UI may have changed. Open every image in `docs/screenshots` and confirm that it shows the feature correctly. Update any README text they no longer match. The images go in the push.
- **If it lists nothing,** undo the rewritten images with `git restore docs/screenshots`, so the push doesn't carry images that only differ by a few pixels.

### 3. Keep personal details out

Every author and committer address on the new commits must end in `users.noreply.github.com`:

```sh
git log --format='%ae%n%ce' FETCH_HEAD..HEAD | sort -u
```

Don't publish personal email addresses, machine paths or credentials. Don't publish anything from `input/` or `output/`.

### 4. Push

Push to `main` of `raajahuja/OSMAnalytics`, and include any updated images and baselines. Never force-push.

Only push commits that descend from GitHub's `main`. Older local branches, including `public-readiness`, have different history and personal details in their commits, so bring changes across from them instead of pushing them.

### 5. Confirm it passed on GitHub

Wait for the CI run on that commit to finish, and tell the user the result. If it fails, fix the cause.
