import type { Page } from "@playwright/test"
import { test as setup, expect } from "../fixtures"
import {
	dismissStartupReminders,
	firstMatchingRowName,
	selectAndDeleteTrashRow,
	selectAndTrashRow,
	waitForListingSettled
} from "../helpers/listing"
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

type Listbox = ReturnType<Page["getByRole"]>

// One item per round, re-scanned from scratch next round — a batch multi-select would go stale the
// moment the listing reorders under it, which a debris-heavy listing guarantees, and every removal here
// must act on a row whose name was just matched against isScratchDebrisName. A row that refuses to go
// is remembered and skipped instead of retried until the budget is gone.
async function sweepListing(page: Page, surface: string, remove: (listbox: Listbox, name: string) => Promise<void>): Promise<void> {
	const deadline = Date.now() + SWEEP_BUDGET_MS
	const unsweepable = new Set<string>()

	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		if (Date.now() >= deadline) {
			console.log(`cleanup-setup: ${surface} sweep hit its time budget — leftovers remain for the next run`)

			return
		}

		const { listbox, hasItems } = await waitForListingSettled(page)

		// Fast path: a clean listing costs exactly this one read, every run.
		if (!hasItems) {
			return
		}

		const name = await firstMatchingRowName(listbox, candidate => isScratchDebrisName(candidate) && !unsweepable.has(candidate))

		if (name === null) {
			return
		}

		try {
			await remove(listbox, name)
		} catch {
			unsweepable.add(name)

			console.log(`cleanup-setup: ${surface} sweep could not remove "${name}" — left for the next run`)
		}
	}
}

// The nav click can silently fail to commit under load (menus.spec.ts hit exactly this), which would
// leave the caller sweeping whatever listing is still mounted — so the destination is proven by URL
// before any removal runs, not assumed from the click.
async function gotoSidebarListing(page: Page, linkName: string, url: RegExp): Promise<void> {
	await expect(async () => {
		await page.getByRole("complementary").getByRole("link", { name: linkName, exact: true }).click()
		await expect(page).toHaveURL(url, { timeout: 5_000 })
	}).toPass({ timeout: 30_000 })
}

// Playlists live in the app-created `.filen/Playlists` directory, which the listing sweeps never
// descend into — audio.spec.ts deletes its own from a finally, but a context killed outright leaks one
// permanently. Rows here are plain list items, not listbox options; the name is read off the title
// attribute the row puts on its name span (playlistsPanel.tsx) and matched by the same anchored
// predicate as every other surface.
async function sweepPlaylistDebris(page: Page): Promise<void> {
	await page.getByRole("link", { name: "Playlists", exact: true }).click()
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

		// Same virtualization workaround as enterScratchDirectory (helpers/listing.ts): a tall viewport
		// makes the virtualizer render every row in one pass, so the round-by-round scan below never
		// misses a debris row sitting below an unscrolled fold.
		await page.setViewportSize({ width: 1280, height: 8000 })

		await sweepListing(page, "drive root", (listbox, name) => selectAndTrashRow(page, listbox, name))

		// Nothing else sweeps /trash: every net-zero spec ends by moving its scratch directory THERE, and
		// both destructive confirms in the suite are deliberately cancelled, so without this the shared
		// account accumulates a run's worth of trashed directories forever — which is what already forced
		// tall-viewport and sort-order workarounds into the drive specs. Row by row and prefix-matched:
		// the toolbar's "Empty trash" would destroy content this suite never created.
		await gotoSidebarListing(page, "Trash", /\/trash$/)
		await sweepListing(page, "trash", (listbox, name) => selectAndDeleteTrashRow(page, listbox, name))

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
			page.evaluate(p => window.__filenE2E.sweepTestNotesByTitlePrefix(p), prefix)
		)
		await sweepPrefixes("tag", TAG_DEBRIS_NAME_PREFIXES, prefix =>
			page.evaluate(p => window.__filenE2E.sweepTestTagsByNamePrefix(p), prefix)
		)
		// Chats: self-chat fixtures leaked by a dead chats.spec run (createChat fights a
		// conversations/create rate limit, so leaks compound fast).
		await sweepPrefixes("conversation", CHAT_DEBRIS_NAME_PREFIXES, prefix =>
			page.evaluate(p => window.__filenE2E.sweepTestChatsByNamePrefix(p), prefix)
		)
	} catch (error) {
		console.log(`cleanup-setup: notes-side sweep stopped early — ${String(error)}`)
	}
})
