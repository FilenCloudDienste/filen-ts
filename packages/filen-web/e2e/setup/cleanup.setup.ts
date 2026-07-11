import { test as setup, expect } from "../fixtures"
import { firstMatchingRowName, selectAndTrashRow, waitForListingSettled } from "../helpers/listing"
import { isScratchDebrisName, NOTE_DEBRIS_TITLE_PREFIXES, TAG_DEBRIS_NAME_PREFIXES } from "@/e2e-hooks/scratchDebris"

// Runs after auth-setup (project dependency in playwright.config.ts). Every suite run self-cleans
// before any spec project starts: a spec that dies mid-flight never reaches its own finally-teardown,
// and that leftover debris compounds row-churn flakes (drive) or starves the hard 10-note cap (notes)
// in every LATER run against the same shared live account. The two sweeps below touch disjoint
// surfaces (drive root listing UI vs. programmatic notes/tags hooks), so fullyParallel running them
// in separate workers is safe — and better than serial mode, where a drive-sweep failure would skip
// the notes sweep entirely. See scratchDebris.ts for the prefix unions.
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

// Notes-side counterpart: notes debris is WORSE than drive debris — the FREE account's note cap is a
// hard 10 (server-enforced `note_limit_reached`), so a few leaked notes starve every later run's own
// createNote calls outright. Tags leak separately (they outlive their notes; deleting a note never
// deletes the tags on it). Programmatic sweep through the same e2e hooks the specs' own teardowns
// use — no UI interaction, so the blocking startup reminders never gate it.
setup("sweep notes and tags matching a spec-minted debris prefix", async ({ page, injectedSession }) => {
	expect(injectedSession.length).toBeGreaterThan(0)

	await page.goto("/drive")

	// The hooks issue authed SDK reads, which need the injected session actually resumed — the authed
	// shell's nav landmark is the same readiness signal the notes specs themselves wait on before
	// calling these hooks.
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	for (const prefix of NOTE_DEBRIS_TITLE_PREFIXES) {
		const removed = await page.evaluate(p => window.__filenE2E.sweepTestNotesByTitlePrefix(p), prefix)

		if (removed > 0) {
			console.log(`cleanup-setup: swept ${String(removed)} leaked note(s) titled "${prefix}…"`)
		}
	}

	for (const prefix of TAG_DEBRIS_NAME_PREFIXES) {
		const removed = await page.evaluate(p => window.__filenE2E.sweepTestTagsByNamePrefix(p), prefix)

		if (removed > 0) {
			console.log(`cleanup-setup: swept ${String(removed)} leaked tag(s) named "${prefix}…"`)
		}
	}
})
