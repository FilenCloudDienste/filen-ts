import { existsSync, rmSync } from "node:fs"
import { test as teardown, expect, FIXTURES_FILE, readFixtureManifest } from "../fixtures"
import { dismissStartupReminders, trashScratchDirectory } from "../helpers/listing"

// Removes the shared fixture tree setup/fixtures.setup.ts built. Wired as `teardown` on the
// fixtures-setup project (playwright.config.ts), so Playwright runs it only after that project AND
// every project depending on it has finished — nothing can still be reading the tree when it goes.
//
// ONE trash for the whole run: the fixture root is a single row at the account root, and trashing a
// directory takes its subtree with it. That is the entire write cost of teardown, against one
// create+trash pair per test before.
teardown.describe.configure({ retries: 0 })

// Wider than the default write budget: this is a directory holding thirteen subdirectories and 26
// files, so the server-side move is doing real work — the same reason drive-search.spec.ts widens its
// own nested-tree teardown.
const TEARDOWN_CONFIRM_TIMEOUT_MS = 120_000

teardown("trash the shared read-only fixture tree", async ({ page, injectedSession }) => {
	expect(injectedSession.length).toBeGreaterThan(0)

	// A teardown project still runs when its owner FAILED, and fixtures-setup writes the manifest only
	// once the root directory exists — so a setup that died on that very first create leaves nothing to
	// remove here. Reporting that as a second failure would bury the real one, so it is a clean no-op.
	if (!existsSync(FIXTURES_FILE)) {
		console.log("fixtures-teardown: no fixture manifest — fixtures-setup never got as far as creating a root, nothing to trash")

		return
	}

	const { fixtureRoot } = readFixtureManifest()

	await page.goto("/drive")

	// THE RULE (helpers/listing.ts): the authed shell raises a BLOCKING startup-reminder alertdialog on
	// every page load, and it renders the rest of the app inert until dismissed. trashScratchDirectory
	// opens by clicking the sidebar, so without this the click waits out its whole budget against a link
	// that is present but never actionable (observed live: "waiting for element to be visible, enabled
	// and stable"). Every spec that calls it has already settled a listing on this page; a teardown that
	// starts from a fresh load has not.
	await dismissStartupReminders(page)

	// Same virtualization workaround as everywhere else: trashScratchDirectory locates the root row by
	// name, and a virtualized listing may not have mounted it.
	await page.setViewportSize({ width: 1280, height: 8000 })

	// Best-effort, exactly like cleanup.setup.ts's own sweeps: this runs after every test has already
	// passed or failed, so letting a contended `drive-write` lease here turn a green run red would
	// report a hygiene problem as a product failure. The leftover is not lost — the name starts "e2e-",
	// which is what cleanup-setup's debris sweep matches on the next run.
	try {
		await trashScratchDirectory(page, fixtureRoot, TEARDOWN_CONFIRM_TIMEOUT_MS)
	} catch (error) {
		console.log(`fixtures-teardown: could not trash "${fixtureRoot}" — left for the next run's sweep (${String(error)})`)
	}

	// Dropped either way: the manifest describes a tree that is gone (or abandoned), and leaving it
	// behind would let a later `--project=chromium-read` run against a stale root and fail with row
	// timeouts instead of the plain "fixtures-setup has not run" readFixtureManifest raises.
	rmSync(FIXTURES_FILE, { force: true })
})
