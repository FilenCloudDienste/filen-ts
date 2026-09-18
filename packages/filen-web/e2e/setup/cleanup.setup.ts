import type { Page } from "@playwright/test"
import { test as setup, expect } from "../fixtures"
import { dismissStartupReminders } from "../helpers/listing"
import { waitForE2eHooks } from "../helpers/e2eHooks"
import {
	isScratchDebrisName,
	NOTE_DEBRIS_TITLE_PREFIXES,
	TAG_DEBRIS_NAME_PREFIXES,
	CHAT_DEBRIS_NAME_PREFIXES
} from "@/e2e-hooks/scratchDebris"

// Runs after auth-setup (project dependency in playwright.config.ts). Every suite run self-cleans
// before any spec project starts: a spec that dies mid-flight never reaches its own finally-teardown,
// and that leftover debris compounds row-churn flakes (drive) or starves the hard 10-note cap (notes)
// in every LATER run against the same shared live account. The two setups below touch disjoint
// surfaces (drive listing UI vs. programmatic notes/tags/chats hooks), so fullyParallel running them
// in separate workers is safe — and better than serial mode, where one failing would skip the other.
// See scratchDebris.ts for the prefix unions.
//
// EVERY sweep step is best-effort. These setups gate every spec project, so a hygiene failure — a
// rate-limited delete, a transient listing error, an account with more debris than one run can drain —
// must never be the reason the suite does not run. Leftovers are logged and picked up next run.
setup.describe.configure({ retries: 0 })

// Wall-clock budget per swept surface: bounding on elapsed time rather than a round count is what
// keeps a backlog from consuming the whole setup timeout (playwright.config.ts) and taking the run
// with it. Sized so all three surfaces together stay well inside that timeout. A sweep that runs out
// simply leaves the rest for the next run.
const SWEEP_BUDGET_MS = 150_000

// Defensive bound only — not tuned to any known leftover count. A predicate bug turning this into an
// unbounded remove-everything loop against the shared live account is the one failure mode this guards.
const MAX_ROUNDS = 500

// Drive debris only costs row churn, so its window is longer than any run — including CI's
// 120-minute global timeout — and a concurrent suite's live fixtures can never be inside it.
const MIN_DRIVE_DEBRIS_AGE_MS = 3 * 60 * 60_000

// Notes/tags/chats sit under hard caps (see the notes-side setup below), so a killed run's leak has to
// drain on the NEXT run rather than three hours later. Still far longer than a concurrent run's live
// fixtures, each of which lives a few minutes inside one serial test.
const MIN_NOTES_SIDE_DEBRIS_AGE_MS = 15 * 60_000

// Removals per programmatic batch. Small enough that a budget check between batches bounds the
// overshoot to seconds, large enough that draining a real backlog does not spend its time on round
// trips — the first live run of this cleared 1,224 rows.
const SWEEP_BATCH = 50

// Batches, with the budget checked BETWEEN batches — the shape the old per-round check got wrong by
// letting a round that started inside the deadline run to completion outside it. A batch of
// SWEEP_BATCH removals is the most this can overshoot by, instead of a whole surface. Draining is
// bounded but not abandoned: whatever is left is reported and picked up next run.
async function sweepDriveSurface(page: Page, target: "root" | "trash"): Promise<number> {
	const deadline = Date.now() + SWEEP_BUDGET_MS
	let total = 0

	while (Date.now() < deadline) {
		const removed = await page.evaluate(
			([surface, limit, minAgeMs]) => window.__filenE2E.sweepTestDriveDebris(surface, limit, minAgeMs),
			[target, SWEEP_BATCH, MIN_DRIVE_DEBRIS_AGE_MS] as const
		)

		total += removed

		// A short batch means the surface is drained (or the rest refused, which the hook already
		// skipped past) — either way there is nothing a further pass would reach.
		if (removed < SWEEP_BATCH) {
			return total
		}
	}

	console.log(`cleanup-setup: ${target} sweep hit its budget after ${String(total)} rows — leftovers remain for the next run`)

	return total
}

// Playlists live in the app-created `.filen/Playlists` directory, which the listing sweeps never
// descend into — audio.spec.ts deletes its own from a finally, but a context killed outright leaks one
// permanently. Rows here are plain list items, not listbox options; the name is read off the title
// attribute the row puts on its name span (playlistsPanel.tsx) and matched by the same anchored
// predicate as every other surface.
async function sweepPlaylistDebris(page: Page): Promise<void> {
	// Through the proven nav, like every other surface here: a bare click can silently fail to commit
	// under load, and this one runs straight after the drive sweep — so an uncommitted click would have
	// scanned whatever listing was still mounted and reported "nothing to sweep".
	// NOT gotoSidebarListing: that scopes to the contextual sidebar (`complementary`), and Playlists is
	// an icon-RAIL entry — scoping it there found nothing and burned the click's whole timeout. Same URL
	// proof, unscoped locator.
	await expect(async () => {
		await page.getByRole("link", { name: "Playlists", exact: true }).click()
		await expect(page).toHaveURL(/\/playlists$/, { timeout: 5_000 })
	}).toPass({ timeout: 30_000 })
	await expect(page.getByRole("heading", { name: "Playlists", exact: true })).toBeVisible()

	const deadline = Date.now() + SWEEP_BUDGET_MS
	const unsweepable = new Set<string>()

	for (let round = 0; round < MAX_ROUNDS && Date.now() < deadline; round += 1) {
		const names = await page
			.getByRole("listitem")
			.evaluateAll(rows => rows.map(row => row.querySelector("span[title]")?.getAttribute("title") ?? ""))
		const name = names.find(candidate => isScratchDebrisName(candidate) && !unsweepable.has(candidate))

		if (name === undefined) {
			return
		}

		const row = page.getByRole("listitem").filter({ hasText: name })

		try {
			await row.getByRole("button", { name: "Playlist options" }).click()
			await page.getByRole("menuitem", { name: "Delete" }).click()
			await page.getByRole("alertdialog", { name: "Delete playlist" }).getByRole("button", { name: "Delete", exact: true }).click()
			await expect(row).toHaveCount(0, { timeout: 15_000 })
		} catch {
			unsweepable.add(name)

			console.log(`cleanup-setup: playlist sweep could not remove "${name}" — left for the next run`)
		}
	}
}

// Programmatic counterpart to the listing sweeps: one hook call per prefix, each failure swallowed on
// its own so a rate-limited delete inside one sweep never skips the prefixes after it.
async function sweepPrefixes(kind: string, prefixes: readonly string[], sweep: (prefix: string) => Promise<number>): Promise<void> {
	for (const prefix of prefixes) {
		try {
			const removed = await sweep(prefix)

			if (removed > 0) {
				console.log(`cleanup-setup: swept ${String(removed)} leaked ${kind}(s) matching "${prefix}…"`)
			}
		} catch (error) {
			console.log(`cleanup-setup: ${kind} sweep for "${prefix}…" failed — left for the next run (${String(error)})`)
		}
	}
}

setup("sweep drive, trash and playlist debris matching a retired scratch-name prefix", async ({ page, injectedSession }) => {
	// Same convention every other authed spec uses (auth.spec.ts, downloads.spec.ts, contacts.spec.ts,
	// boot.spec.ts): asserting the session actually came back — not just requesting it — proves the
	// fixture's addInitScript seeding ran, rather than silently continuing against an unauthenticated
	// page that would only surface as a confusing waitForListingSettled timeout below. The one fatal
	// condition here: without a session nothing in the run could pass anyway.
	expect(injectedSession.length).toBeGreaterThan(0)

	try {
		await page.goto("/drive")
		await waitForE2eHooks(page)

		// Through the SDK, not the listing. The UI sweep this replaces had to render a debris-heavy
		// root, defeat the virtualizer with an 8000px viewport, then drive a select/confirm/toast cycle
		// per row inside a wall-clock budget that was only checked BETWEEN rounds — so a single round
		// could overrun it by minutes, and on a busy account it simply ran out and left the rest for
		// "the next run", every run. Each write-lane spec brackets itself with a scratch directory, so a
		// run produces ~22 of them plus the fixture tree; the sweep has to be able to outpace that.
		// Same anchored isScratchDebrisName predicate as before, so nothing this suite did not create is
		// reachable — "Empty trash" still stays off the table. Root moves matches to trash; trash then
		// deletes permanently, which is why root runs first.
		const trashedFromRoot = await sweepDriveSurface(page, "root")
		const deletedFromTrash = await sweepDriveSurface(page, "trash")

		console.log(`cleanup-setup: swept ${String(trashedFromRoot)} root rows, ${String(deletedFromTrash)} trash rows`)

		await sweepPlaylistDebris(page)
	} catch (error) {
		console.log(`cleanup-setup: drive-side sweep stopped early — ${String(error)}`)
	}
})

// Notes-side counterpart: notes debris is WORSE than drive debris — the FREE account's note cap is a
// hard 10 (server-enforced `note_limit_reached`), so a few leaked notes starve every later run's own
// createNote calls outright. Tags leak separately (they outlive their notes; deleting a note never
// deletes the tags on it). Programmatic sweep through the same e2e hooks the specs' own teardowns
// use — no UI interaction, so the blocking startup reminders never gate it.
setup("sweep notes, tags and chats matching a spec-minted debris prefix", async ({ page, injectedSession }) => {
	expect(injectedSession.length).toBeGreaterThan(0)

	try {
		await page.goto("/drive")

		// The hooks issue authed SDK reads, which need the injected session actually resumed — the authed
		// shell's nav landmark is the same readiness signal the notes specs themselves wait on before
		// calling these hooks, and the blocking startup reminder has to be gone before that landmark is
		// in the role tree at all (THE RULE, helpers/listing.ts).
		await dismissStartupReminders(page)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		await sweepPrefixes("note", NOTE_DEBRIS_TITLE_PREFIXES, prefix =>
			page.evaluate(([p, minAgeMs]) => window.__filenE2E.sweepTestNotesByTitlePrefix(p, minAgeMs), [
				prefix,
				MIN_NOTES_SIDE_DEBRIS_AGE_MS
			] as const)
		)
		await sweepPrefixes("tag", TAG_DEBRIS_NAME_PREFIXES, prefix =>
			page.evaluate(([p, minAgeMs]) => window.__filenE2E.sweepTestTagsByNamePrefix(p, minAgeMs), [
				prefix,
				MIN_NOTES_SIDE_DEBRIS_AGE_MS
			] as const)
		)
		// Chats: self-chat fixtures leaked by a dead chats.spec run (createChat fights a
		// conversations/create rate limit, so leaks compound fast).
		await sweepPrefixes("conversation", CHAT_DEBRIS_NAME_PREFIXES, prefix =>
			page.evaluate(([p, minAgeMs]) => window.__filenE2E.sweepTestChatsByNamePrefix(p, minAgeMs), [
				prefix,
				MIN_NOTES_SIDE_DEBRIS_AGE_MS
			] as const)
		)
	} catch (error) {
		console.log(`cleanup-setup: notes-side sweep stopped early — ${String(error)}`)
	}
})
