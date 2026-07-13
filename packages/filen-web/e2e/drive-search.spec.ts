import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { waitForListingSettled, trashScratchDirectory, descendInto } from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"
import { trackCspViolations } from "./helpers/csp"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

async function createDirectory(page: Page, listbox: ReturnType<Page["getByRole"]>, name: string): Promise<void> {
	// .first(): an empty writable listing renders a second identical button inside its empty-state
	// "+ Add" affordance; the toolbar's copy is always first in DOM order (see enterScratchDirectory).
	await page.getByRole("button", { name: "New directory", exact: true }).first().click()
	const dialog = page.getByRole("dialog")
	await expect(dialog).toBeVisible()
	await page.getByLabel("Name", { exact: true }).fill(name)
	await page.getByRole("button", { name: "Create", exact: true }).click()
	await expect(dialog).toHaveCount(0)

	await expect(listbox.getByRole("option", { name })).toBeVisible()
}

// The one live proof the whole subtree search feature works end to end: a real
// configureCache/createSearch/getRange round trip against the live cache-search engine, real
// convergence timing, and the toolbar/keymap/navigation wiring around it — none of that is provable
// at the unit level (searchStatus.logic.test.ts/useDriveSearch.test.ts/searchEngine.test.ts all
// inject or fake the engine). Runs as one scenario rather than several smaller tests: every leg reuses
// the SAME scratch tree, and splitting it would multiply the number of cold convergence waits (each
// several seconds) without adding coverage.
test("subtree search finds a nested file with its parent path, mod+f focuses it, hits navigate/preview per type, and Escape/no-results both resolve", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-search-${runId}`
	// Embeds the run's own suffix too (not a plain "nested") so the SAME search query surfaces this as
	// a directory hit alongside the file below, rather than only ever matching one item.
	const nestedName = `nested-${runId}`
	const targetName = `target-${runId}.txt`
	const targetContent = "filen web e2e search target"
	const modKey = await resolveModKey(page)

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	try {
		// A generous viewport defeats virtualization for the root listing too — the shared account's
		// root can hold enough items that a specific named row would otherwise never mount.
		await page.setViewportSize({ width: 1280, height: 8000 })
		const { listbox: rootListbox } = await waitForListingSettled(page)

		// Build the scratch tree: <scratchName>/<nestedName>/<targetName> — two levels deep, so finding
		// the file proves real subtree recursion, not just a one-level filter. Both directory names ride
		// the run's own unique suffix so a search for it also surfaces a directory hit, not only the file.
		await createDirectory(page, rootListbox, scratchName)
		await descendInto(page, rootListbox, scratchName)

		const { listbox: scratchListbox } = await waitForListingSettled(page)
		await createDirectory(page, scratchListbox, nestedName)
		await descendInto(page, scratchListbox, nestedName)

		const { listbox: nestedListbox } = await waitForListingSettled(page)
		await page
			.locator('input[type="file"]')
			.first()
			.setInputFiles({ name: targetName, mimeType: "text/plain", buffer: Buffer.from(targetContent, "utf8") })
		await expect(nestedListbox.getByRole("option", { name: targetName })).toBeVisible({ timeout: 40_000 })

		// Back up to the scratch directory's own top (not the account root) via the sidebar link then a
		// fresh descent — the search below is scoped to THIS run's own small subtree rather than the
		// whole shared, actively-mutating account: cache-search convergence for a directory not yet
		// covered by an active sync resyncs before results land, and doing that over the account's full,
		// unbounded (and constantly growing) content is measured in whatever-that-happens-to-be, not the
		// bounded ~5s a two-item scratch subtree converges in (the number the timeouts below are sized
		// against) — reproduced live: an account-root-scoped search here timed out past 45s. Subtree
		// recursion is still fully proven (the file sits two levels below where the search opens).
		await page.getByRole("complementary").getByRole("link", { name: "Cloud Drive", exact: true }).click()
		const { listbox: rootListboxAgain } = await waitForListingSettled(page)
		await descendInto(page, rootListboxAgain, scratchName)

		const searchInput = page.getByLabel("Search", { exact: true })
		await expect(searchInput).not.toBeFocused()
		await page.keyboard.press(`${modKey}+f`)
		await expect(searchInput).toBeFocused()

		// Typed per keystroke, not fill(): fill dispatches ONE input event with the whole value, which
		// structurally cannot exercise the keystrokes-during-open-round-trip path a real user always
		// takes — the exact path where an unserialized reopen once killed the engine's convergence
		// resync per keystroke (useDriveSearch.ts's pendingQueryRef doc comment tells that story).
		await searchInput.pressSequentially(runId, { delay: 40 })

		// Cold convergence for a fresh search root (not yet covered by an active sync) is observed at
		// 4.9-6.6s against a scratch directory this size in this same account — a generous ceiling covers
		// slower runs without chasing the unbounded, whole-account case. Results are push-fed live, so
		// this asserts the eventual settled state rather than any particular intermediate status text.
		const listbox = page.getByRole("listbox", { name: "Directory contents" })
		const targetHit = listbox.getByRole("option", { name: targetName })
		await expect(targetHit).toBeVisible({ timeout: 40_000 })
		await expect(targetHit).toContainText(nestedName)

		// Anchored regex, not a plain-string (substring) match: the target file's OWN row renders its
		// parentPath as a second text segment (nestedName, asserted above) which is itself concatenated
		// into that row's accessible name — a bare-string { name: nestedName } query ambiguously matches
		// BOTH rows (reproduced live: a Playwright strict-mode violation). Anchoring to the start of the
		// name selects only the row whose OWN name — not a parent-path aside — is it.
		const dirHit = listbox.getByRole("option", { name: new RegExp(`^${nestedName}`) })
		await expect(dirHit).toBeVisible()

		// A file hit opens the normal preview overlay, paging over the search RESULT set — Escape closes
		// just the overlay; search stays active with the same results (mirrors preview.spec.ts's own
		// text-preview leg). dblclick fires an intermediate click first (the row's onClick/onDoubleClick
		// are separate handlers, standard DOM dblclick behavior), which selects the row and swaps the
		// toolbar for the bulk-action bar — a second Escape (the dialog's own close already consumed the
		// first) reaches the global clear-selection action and restores the search input to view.
		await targetHit.dblclick()
		await expect(page.getByRole("dialog").getByText(targetContent)).toBeVisible({ timeout: 30_000 })
		await page.keyboard.press("Escape")
		await expect(page.locator(".cm-content")).toHaveCount(0)
		await page.keyboard.press("Escape")
		await expect(searchInput).toHaveValue(runId)

		// A directory hit navigates straight into it (root-relative, regardless of where the search was
		// typed from) and leaves search entirely — old-web parity.
		await dirHit.dblclick()
		await expect(page).toHaveURL(/\/drive\/[^/]+$/)
		await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText(nestedName, { exact: true })).toBeVisible()
		await expect(searchInput).toHaveValue("")

		const { listbox: afterNavListbox } = await waitForListingSettled(page)
		await expect(afterNavListbox.getByRole("option", { name: targetName })).toBeVisible()

		// A second search, now scoped to this even smaller subtree (a single file) — proves a fresh root
		// re-opens the engine cleanly, not just the one cold open already exercised above.
		await searchInput.fill(targetName)
		await expect(listbox.getByRole("option", { name: targetName })).toBeVisible({ timeout: 40_000 })

		// Escape (while the input itself is focused) clears the query and restores the normal listing —
		// distinct from the directory-hit case above, which clears via navigation instead.
		await searchInput.focus()
		await page.keyboard.press("Escape")
		await expect(searchInput).toHaveValue("")
		await expect(afterNavListbox.getByRole("option", { name: targetName })).toBeVisible()

		// A query with no chance of ever matching anything in this small subtree.
		await searchInput.fill(`e2e-search-no-such-query-${crypto.randomUUID()}`)
		await expect(page.getByText("No matches", { exact: true })).toBeVisible({ timeout: 45_000 })

		await page.getByRole("button", { name: "Clear search", exact: true }).click()
		await expect(searchInput).toHaveValue("")

		expect(cspViolations).toEqual([])
	} finally {
		// This scratch directory still holds its own nested subtree (nested/target-*.txt) at cleanup
		// time, unlike every other spec's flat/already-emptied scratch directory — a generous timeout
		// covers the larger trash operation rather than the default 15s.
		await trashScratchDirectory(page, scratchName, 30_000)
	}
})
