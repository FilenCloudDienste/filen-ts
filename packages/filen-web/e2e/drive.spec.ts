import { test, expect } from "./fixtures"
import { bootTo, clickSidebarLink, waitForListingSettled } from "./helpers/listing"
import { enterFixtureRoot, FIXTURE_FILES } from "./helpers/fixtures"
import { resolveModKey } from "./helpers/modkey"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Nothing here ever creates, renames, moves, or deletes anything: the new-directory flow is exercised
// only up to dialog validation, never submitted — a live create has no net-zero counterpart yet
// (trash/delete are not exercised live here) and the create logic itself already has unit coverage
// (createDirectory.test.ts).
//
// Every test that reads ROWS reads them from the shared fixture root (helpers/fixtures.ts), never from
// Cloud Drive's own root: that root is where every write-lane spec creates and trashes its scratch
// directory, so a `.first()`/`.nth()`/`.count()` taken there races those writes — an interference that
// already reproduced live as a flaky failure of the selection test below. The fixture root is one
// directory per scenario, read-only for the whole run, and its row set is therefore both stable and
// known. Only the tests that read no rows at all (the toolbar/menu/separator ones) stay at the root.
//
// Every test here needs the listing's real, authenticated listDir call to settle, which hangs on
// Playwright-firefox — see helpers/firefox.ts (FIREFOX_HANG_REASON) for the proven root cause. Live-
// verified: on firefox the listing sits on its loading skeleton forever, the toolbar stays permanently
// disabled, and neither terminal render state is reached.

// One directory per scenario, built once by the fixtures-setup project — the fixture root's exact row
// count, which the select-all assertion below is pinned to rather than to a snapshot read at runtime.
const FIXTURE_ROOT_ROW_COUNT = Object.keys(FIXTURE_FILES).length

test.describe("drive", () => {
	test("the Cloud Drive listing renders the shell, breadcrumb, and directory contents region", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
		const { listbox } = await waitForListingSettled(page)

		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })
		await expect(breadcrumb).toBeVisible()
		const rootCrumb = breadcrumb.getByText("Cloud Drive", { exact: true })
		await expect(rootCrumb).toBeVisible()
		await expect(rootCrumb).toHaveAttribute("aria-current", "page")

		// Unconditional, not a hasItems branch: the fixtures-setup project's own root directory sits at
		// /drive for the whole run, so this listing always has rows. The row itself is the only thing
		// read here — which one it is never matters — so the write lane's churn at this root cannot
		// reach the assertion.
		await expect(listbox.getByRole("option").first()).toBeVisible()
	})

	test("navigating into a subdirectory grows the URL and breadcrumb and requeries the listing", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
		const { listbox } = await enterFixtureRoot(page)

		const beforeUrl = page.url()
		await listbox.getByRole("option").first().dblclick()

		// Every row in the fixture root is a scenario DIRECTORY, so the double-click always resolves a
		// navigation target (features/drive/lib/navigate.ts resolves directories only) — no
		// file-row-degrades-to-a-skip case left to gate on.
		await page.waitForURL(url => url.toString() !== beforeUrl)

		// Two splat segments now, not one: this started a level in, inside the fixture root.
		expect(page.url()).toMatch(/\/drive\/[^/]+\/[^/]+$/)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		// The root breadcrumb segment becomes a real link once a step deeper than root.
		const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })
		await expect(breadcrumb.getByRole("link", { name: "Cloud Drive", exact: true })).toBeVisible()

		// The listing re-queries for the new directory and settles the same way root did.
		await waitForListingSettled(page)
	})

	test("an open dialog closes when a history pop changes the location under the same route", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		// The axis matters: /drive and /drive/<uuid> are ONE route (routes/_app/drive.$.tsx), so a pop
		// along the splat re-renders the listing in place and its dialog host survives — which is the
		// only state in which closing an open dialog is this host's job. A pop across two DIFFERENT
		// routes unmounts the host outright and would pass with or without the fix.
		await bootTo(page)
		const { listbox } = await enterFixtureRoot(page)

		const fixtureRootUrl = page.url()
		await listbox.getByRole("option").first().dblclick()
		await page.waitForURL(url => url.toString() !== fixtureRootUrl)

		await waitForListingSettled(page)
		await page.goBack()
		await page.waitForURL(fixtureRootUrl)
		const root = await waitForListingSettled(page)

		// Info is a pure read dialog — nothing is created or destroyed by opening it.
		async function openInfoOn(list: ReturnType<typeof page.getByRole>): Promise<void> {
			await list.getByRole("option").first().getByRole("button", { name: "More actions", exact: true }).click()
			await page.getByRole("menu").getByRole("menuitem", { name: "Info", exact: true }).click()
			await expect(page.getByRole("dialog")).toBeVisible()
		}

		await openInfoOn(root.listbox)
		await page.goForward()
		await expect(page.getByRole("dialog")).toHaveCount(0)

		// The literal browser-Back wording of the same rule. Every fixture scenario holds at least one
		// file, so the subdirectory always has a row to open a dialog on.
		const nested = await waitForListingSettled(page)

		await openInfoOn(nested.listbox)
		await page.goBack()
		await expect(page.getByRole("dialog")).toHaveCount(0)
	})

	test("view mode toggles between list and grid and persists across a reload", async ({ page, injectedSession, browserName }) => {
		// Doubly chromium-only: the initial listing read already hangs on firefox (see
		// FIREFOX_HANG_REASON above), and even past that, reloading an already-authed page hits
		// Playwright-firefox's separate documented authed-shell-reload instability (auth.spec.ts's own
		// reload test carries the identical gate for the identical reason).
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
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
		await waitForListingSettled(page)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
		await page.getByRole("button", { name: "Display", exact: true }).click()
		await expect(page.getByRole("menuitemradio", { name: "Grid view", exact: true })).toHaveAttribute("aria-checked", "true")
		await page.keyboard.press("Escape")
	})

	test("the sidebar resize separator is keyboard-operable and two presses compound", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
		await waitForListingSettled(page)

		// The drive route renders exactly one such separator (the notes md split pane's own is labelled
		// differently and lives on another route).
		const handle = page.getByRole("separator", { name: "Resize sidebar" }).first()
		const before = Number(await handle.getAttribute("aria-valuenow"))

		// MIN 240 / MAX 520 is a 280px range, so from any starting width exactly one direction is
		// guaranteed two full 16px steps of headroom — no clamp guessing in the assertions.
		const grow = before + 32 <= 520
		const forward = grow ? "ArrowRight" : "ArrowLeft"
		const back = grow ? "ArrowLeft" : "ArrowRight"

		await handle.focus()
		await handle.press(forward)
		await handle.press(forward)

		await expect(handle).toHaveAttribute("aria-valuenow", String(grow ? before + 32 : before - 32))

		// Restore, so the shared browser-local kv is net-zero for the next spec.
		await handle.press(back)
		await handle.press(back)

		await expect(handle).toHaveAttribute("aria-valuenow", String(before))
	})

	test("the sort menu opens, a field/direction selection reflects and survives close/reopen", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
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

		await bootTo(page)
		// enterFixtureRoot forces the tall viewport the select-all assertion needs: the selected-rows
		// count must equal the bar's total, which only holds when no selected row sits unmounted below
		// the fold.
		const { listbox } = await enterFixtureRoot(page)
		const modKey = await resolveModKey(page)

		await expect(listbox.getByRole("option")).toHaveCount(FIXTURE_ROOT_ROW_COUNT)

		const firstOption = listbox.getByRole("option").first()
		await firstOption.click()
		await expect(firstOption).toHaveAttribute("aria-selected", "true")
		await expect(listbox.getByRole("option", { selected: true })).toHaveCount(1)
		await expect(page.getByText("1 selected", { exact: true })).toBeVisible()

		// Against the fixture root's known, unchanging row count rather than a snapshot read at runtime:
		// nothing creates or trashes in here, so select-all has an exact expected result and the bar's
		// own readout can be asserted outright.
		await page.keyboard.press(`${modKey}+a`)
		await expect(listbox.getByRole("option", { selected: true })).toHaveCount(FIXTURE_ROOT_ROW_COUNT)
		await expect(page.getByText(`${String(FIXTURE_ROOT_ROW_COUNT)} selected`, { exact: true })).toBeVisible()

		await page.keyboard.press("Escape")
		await expect(listbox.getByRole("option", { selected: true })).toHaveCount(0)
		// The floating selection bar unmounts with the cleared selection.
		await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0)

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

		await bootTo(page)
		await waitForListingSettled(page)

		// .first(): an EMPTY writable listing renders a second identical trigger inside its empty-state
		// "+ Add" affordance; the toolbar's is always first in DOM order.
		const newDirButton = page.getByRole("button", { name: "New directory", exact: true }).first()
		await expect(newDirButton).toBeEnabled()
		await newDirButton.click()

		// Filtered by its own heading: previewOverlay.tsx composes Base UI's dialog Popup directly, whose
		// role defaults to "dialog" too, so a bare lookup can resolve to the wrong surface.
		const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New directory", exact: true }) })
		await expect(dialog).toBeVisible()

		const submit = dialog.getByRole("button", { name: "Create", exact: true })
		await expect(submit).toBeDisabled()

		const nameInput = dialog.getByLabel("Name", { exact: true })
		await nameInput.fill("e2e probe — never submitted")
		await expect(submit).toBeEnabled()

		await nameInput.fill("   ")
		await expect(submit).toBeDisabled() // whitespace-only is trimmed by the same validator

		// Dismiss without ever pressing Create — this suite never mutates the live account.
		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	})

	// The FREE e2e account cannot create public links (a premium feature), so this leg is graceful-
	// render only: the sidebar Links row must navigate to the /links virtual root, which renders the
	// shell and settles to its listing-or-empty terminal state (whichever the live account happens to
	// be), with no console errors on the links leg — never a link-creation flow. The nav is a
	// client-side sidebar click rather than a cold goto("/links") because the sidebar row IS what this
	// test is about.
	test("the sidebar Links row navigates to the /links virtual root, which renders the shell and settles with no console errors", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page)
		await waitForListingSettled(page)

		// Scope the console-error capture to the links leg alone (post-boot): the assertion below is
		// about the /links render, not the authed shell's own boot.
		const consoleErrors: string[] = []

		page.on("console", msg => {
			if (msg.type() !== "error") {
				return
			}

			const text = msg.text()

			// arktype's benign CSP probe (see shell.spec.ts) — blocked by no-unsafe-eval, not a failure.
			if (/unsafe-eval/i.test(text)) {
				return
			}

			consoleErrors.push(text)
		})

		await clickSidebarLink(page, "Links", /\/links$/)

		// The links query must settle to its own listing-or-empty terminal state (waitForListingSettled
		// resolves on neither only for a real query error) before the shell/breadcrumb assertions.
		await waitForListingSettled(page)

		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })
		await expect(breadcrumb).toBeVisible()
		const rootCrumb = breadcrumb.getByText("Links", { exact: true })
		await expect(rootCrumb).toBeVisible()
		await expect(rootCrumb).toHaveAttribute("aria-current", "page")

		expect(consoleErrors, consoleErrors.join("\n")).toEqual([])
	})
})
