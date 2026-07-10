import { test as setup, expect } from "../fixtures"
import { firstMatchingRowName, selectAndTrashRow, waitForListingSettled } from "../helpers/listing"
import { isScratchDebrisName } from "@/e2e-hooks/scratchDebris"

// Runs after auth-setup (project dependency in playwright.config.ts), workers-serialized the same way
// auth-setup is — this file has exactly one test, so there is never a second worker to race it. Every
// suite run self-cleans before any spec project starts: a spec that dies mid-flight never reaches its
// own finally-teardown (trashScratchDirectory), and that leftover debris compounds row-churn flakes in
// every LATER run against the same shared live account. See scratchDebris.ts for the prefix union.
setup.describe.configure({ retries: 0 })

// Defensive bound only — not tuned to any known leftover count. A predicate bug turning this into an
// unbounded trash-everything loop against the shared live account is the one failure mode this guards.
const MAX_ROUNDS = 500

setup("sweep every root item matching a retired scratch-name prefix", async ({ page, injectedSession }) => {
	// Same convention every other authed spec uses (auth.spec.ts, downloads.spec.ts, contacts.spec.ts,
	// boot.spec.ts): asserting the session actually came back — not just requesting it — proves the
	// fixture's addInitScript seeding ran, rather than silently continuing against an unauthenticated
	// page that would only surface as a confusing waitForListingSettled timeout below.
	expect(injectedSession.length).toBeGreaterThan(0)

	await page.goto("/drive")

	// Same virtualization workaround as enterScratchDirectory (helpers/listing.ts): a tall viewport
	// makes the virtualizer render every root row in one pass, so the round-by-round scan below never
	// misses a debris row sitting below an unscrolled fold.
	await page.setViewportSize({ width: 1280, height: 8000 })

	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		const { listbox, hasItems } = await waitForListingSettled(page)

		// Fast path: a clean root costs exactly this one listing read, every run.
		if (!hasItems) {
			return
		}

		const name = await firstMatchingRowName(listbox, isScratchDebrisName)

		if (name === null) {
			return
		}

		// One item per round, re-scanned from scratch next round — a batch multi-select would go stale
		// the moment the root reorders under it, which a debris-heavy root guarantees.
		await selectAndTrashRow(page, listbox, name)
	}
})
