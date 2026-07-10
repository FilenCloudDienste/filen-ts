import { test, expect } from "./fixtures"
import { waitForListingSettled } from "./helpers/listing"
import { resolveModKey } from "./helpers/modkey"

// The injected session's own account content (Cloud Drive's root) is real, live, and unknown ahead of
// time — every test below holds regardless of whether it is empty or populated (see the per-test
// resilience notes). Nothing here ever creates, renames, moves, or deletes anything: the new-directory
// flow is exercised only up to dialog validation, never submitted — a live create has no net-zero
// counterpart yet (trash/delete land in a later drive sub-slice) and the create logic itself already
// has unit coverage (createDirectory.test.ts).
//
// Chromium-only, empirically (not merely per the reload/second-tab precedent auth.spec.ts and
// storage.spec.ts document): every test here needs the listing's real, authenticated listDir call to
// settle, and that hangs indefinitely on Playwright-firefox under COI — the same root cause
// boot.spec.ts already carves probeAuthedRead out for, just reached from a different call site. Live-
// verified: on firefox the listing sits on its loading skeleton forever and the toolbar stays
// permanently disabled, never reaching either terminal render state.
const FIREFOX_HANG_REASON = "drive listing needs an authenticated listDir call, which hangs indefinitely on Playwright-firefox under COI"

test.describe("drive", () => {
	test("the Cloud Drive listing renders the shell, breadcrumb, and directory contents region", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })
		await expect(breadcrumb).toBeVisible()
		const rootCrumb = breadcrumb.getByText("Cloud Drive", { exact: true })
		await expect(rootCrumb).toBeVisible()
		await expect(rootCrumb).toHaveAttribute("aria-current", "page")

		const { listbox, hasItems } = await waitForListingSettled(page)

		if (hasItems) {
			await expect(listbox.getByRole("option").first()).toBeVisible()
		} else {
			await expect(page.getByText("Nothing here yet")).toBeVisible()
		}
	})

	test("navigating into a subdirectory grows the URL and breadcrumb and requeries the listing", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		const { listbox, hasItems } = await waitForListingSettled(page)

		test.skip(!hasItems, "drive root has no items in this account — nothing to navigate into")

		const beforeUrl = page.url()
		await listbox.getByRole("option").first().dblclick()

		// A file has no navigation target (features/drive/lib/navigate.ts resolves directories only) — opening
		// one is a safe no-op. Only proceed with the deeper assertions if the URL actually grew a splat
		// segment, so an account whose first row happens to be a file degrades to a skip, not a failure.
		const navigated = await page
			.waitForURL(url => url.toString() !== beforeUrl, { timeout: 5000 })
			.then(() => true)
			.catch(() => false)

		test.skip(!navigated, "the first row did not navigate (likely a file, not a directory, in this account)")

		expect(page.url()).toMatch(/\/drive\/[^/]+$/)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		// The root breadcrumb segment becomes a real link once a step deeper than root.
		const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })
		await expect(breadcrumb.getByRole("link", { name: "Cloud Drive", exact: true })).toBeVisible()

		// The listing re-queries for the new directory and settles the same way root did.
		await waitForListingSettled(page)
	})

	test("view mode toggles between list and grid and persists across a reload", async ({ page, injectedSession, browserName }) => {
		// Doubly chromium-only: the initial listing read already hangs on firefox (see
		// FIREFOX_HANG_REASON above), and even past that, reloading an already-authed page hits
		// Playwright-firefox's separate documented authed-shell-reload instability (auth.spec.ts's own
		// reload test carries the identical gate for the identical reason).
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		await waitForListingSettled(page)

		const displayBtn = page.getByRole("button", { name: "Display", exact: true })
		await displayBtn.click()

		const listRadio = page.getByRole("menuitemradio", { name: "List view", exact: true })
		const gridRadio = page.getByRole("menuitemradio", { name: "Grid view", exact: true })

		await expect(listRadio).toHaveAttribute("aria-checked", "true")
		await expect(gridRadio).toHaveAttribute("aria-checked", "false")

		await gridRadio.click()
		await page.keyboard.press("Escape")

		// The pref write + refetch round-trips through OPFS kv asynchronously — reopening the menu reads
		// the settled state through an auto-retrying assertion.
		await displayBtn.click()
		await expect(page.getByRole("menuitemradio", { name: "Grid view", exact: true })).toHaveAttribute("aria-checked", "true")
		await page.keyboard.press("Escape")

		await page.reload()
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
		await waitForListingSettled(page)
		await page.getByRole("button", { name: "Display", exact: true }).click()
		await expect(page.getByRole("menuitemradio", { name: "Grid view", exact: true })).toHaveAttribute("aria-checked", "true")
		await page.keyboard.press("Escape")
	})

	test("the sort menu opens, a field/direction selection reflects and survives close/reopen", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		await waitForListingSettled(page)

		const sortTrigger = page.getByRole("button", { name: "Sort by", exact: true })
		await expect(sortTrigger).toBeEnabled()
		await sortTrigger.click()

		const menu = page.getByRole("menu")
		await expect(menu).toBeVisible()

		const nameRadio = page.getByRole("menuitemradio", { name: "Name", exact: true })
		const sizeRadio = page.getByRole("menuitemradio", { name: "Size", exact: true })
		await expect(nameRadio).toHaveAttribute("aria-checked", "true") // the default sort is nameAsc

		// Selecting a radio item does not close the menu — a second, independent radio group (direction)
		// lives in the same popup, so closing on the first pick would make it unreachable in one open.
		await sizeRadio.click()
		await expect(sizeRadio).toHaveAttribute("aria-checked", "true")
		await expect(nameRadio).toHaveAttribute("aria-checked", "false")

		const descendingRadio = page.getByRole("menuitemradio", { name: "Descending", exact: true })
		await descendingRadio.click()
		await expect(descendingRadio).toHaveAttribute("aria-checked", "true")

		await page.keyboard.press("Escape")
		await expect(menu).toHaveCount(0)

		// Reopening reflects the persisted selection — proves the write round-tripped through kv, not
		// just a component-local click handler.
		await sortTrigger.click()
		await expect(page.getByRole("menuitemradio", { name: "Size", exact: true })).toHaveAttribute("aria-checked", "true")
		await expect(page.getByRole("menuitemradio", { name: "Descending", exact: true })).toHaveAttribute("aria-checked", "true")
		await page.keyboard.press("Escape")
	})

	test("selection: click selects, Cmd/Ctrl+A selects all, Escape clears, Arrow moves the roving cursor", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		const { listbox, hasItems } = await waitForListingSettled(page)
		const modKey = await resolveModKey(page)

		if (!hasItems) {
			// Select-all/clear are registered globally and must be safe no-ops against an empty
			// listbox even with nothing to select.
			await page.keyboard.press(`${modKey}+a`)
			await page.keyboard.press("Escape")
			await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
			test.skip(true, "drive root has no items in this account — nothing to select or move a cursor over")
		}

		const firstOption = listbox.getByRole("option").first()
		await firstOption.click()
		await expect(firstOption).toHaveAttribute("aria-selected", "true")
		await expect(listbox.getByRole("option", { selected: true })).toHaveCount(1)
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()

		const optionCount = await listbox.getByRole("option").count()
		await page.keyboard.press(`${modKey}+a`)
		// The shared account churns under parallel specs, so a pre-read count can go stale between the
		// keypress and the assertion — assert the bar agrees with the LIVE selected-row count instead.
		await expect(async () => {
			const selected = await listbox.getByRole("option", { selected: true }).count()
			expect(selected).toBeGreaterThan(0)
			await expect(page.getByText(`${String(selected)} selected`, { exact: true })).toBeVisible({ timeout: 1000 })
		}).toPass({ timeout: 15_000 })

		await page.keyboard.press("Escape")
		await expect(listbox.getByRole("option", { selected: true })).toHaveCount(0)
		// The floating selection bar unmounts with the cleared selection.
		await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0)

		test.skip(optionCount < 2, "drive root has only one item in this account — no second option for the cursor to move to")

		const second = listbox.getByRole("option").nth(1)
		await firstOption.focus()
		await page.keyboard.press("ArrowDown")
		await expect(second).toBeFocused()
	})

	test("the new-directory dialog opens and gates an empty/whitespace name without creating anything", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/drive")
		await waitForListingSettled(page)

		const newDirButton = page.getByRole("button", { name: "New directory", exact: true })
		await expect(newDirButton).toBeEnabled()
		await newDirButton.click()

		const dialog = page.getByRole("dialog")
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole("heading", { name: "New directory", exact: true })).toBeVisible()

		const submit = page.getByRole("button", { name: "Create", exact: true })
		await expect(submit).toBeDisabled()

		const nameInput = page.getByLabel("Name", { exact: true })
		await nameInput.fill("e2e probe — never submitted")
		await expect(submit).toBeEnabled()

		await nameInput.fill("   ")
		await expect(submit).toBeDisabled() // whitespace-only is trimmed by the same validator

		// Dismiss without ever pressing Create — this suite never mutates the live account.
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	})
})
