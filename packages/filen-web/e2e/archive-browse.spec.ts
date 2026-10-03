import { formatBytes } from "@filen/shared"
import { test, expect } from "./fixtures"
import { archivePasswordPrompt, expectRows, expectRowSize, openArchive, openRowMenu } from "./helpers/archive"
import { HOSTILE_MISLEADING_NAME, NOTE_TEXT, TREE_FILES, ZIPCRYPTO_PASSWORD } from "./helpers/archiveFixtures"
import { trackCspViolations } from "./helpers/csp"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { holdChunks, observeEgest } from "./helpers/jobs"
import { bootTo } from "./helpers/listing"

// The archive browser in the preview overlay, over the shared read-only fixture tree's archives
// (helpers/archiveFixtures.ts builds each, helpers/fixtures.ts names them). Browsing is a pure read —
// the SDK lists, nothing is written — so this spec sits in the read lane, and it never extracts: every
// extract lands in a write spec's own scratch directory.

const [CORRUPT, EMPTY, GARBAGE, HOSTILE, LINKS, LOCKED, NOTE, SMALL, TREE] = FIXTURE_FILES["archive-browse"]
const [GATE_BIG, GATE_NEXT] = FIXTURE_FILES["archive-gate"]
const [HUNDRED_K] = FIXTURE_FILES["archive-huge"]

const textBytes = (path: keyof typeof TREE_FILES): number => Buffer.byteLength(TREE_FILES[path])

// A listing of every entry is the one that takes long: a tarball is downloaded whole, the 100k zip's
// index is 5 MB. Everything else here answers from a zip index read in well under the UI default.
const LISTING_TIMEOUT_MS = 60_000

test.describe("archive browser", () => {
	test("a zip lists at once and its directories navigate by row, crumb and folded crumb", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")
		const browser = await openArchive(page, listbox, TREE)
		const { list, crumbs } = browser

		// A zip's index read starts by itself: no gate, its root at once.
		await expect(list).toHaveAccessibleName(`Contents of ${TREE}`)
		await expect(browser.gate.browse).toHaveCount(0)
		await expectRows(list, ["docs", "empty-dir", "photos", "readme.txt"])
		await expect(browser.row("docs")).toHaveAccessibleName(/\s1 item(\s|$)/)
		await expect(browser.row("photos")).toHaveAccessibleName(/\s2 items(\s|$)/)
		await expect(browser.row("empty-dir")).toHaveAccessibleName(/\s0 items(\s|$)/)
		await expectRowSize(list, "readme.txt", formatBytes(textBytes("readme.txt")))
		await expect(crumbs.getByRole("button", { name: TREE, exact: true })).toHaveAttribute("aria-current", "location")

		await browser.into("photos")
		await browser.into("2024")
		await expect(list).toHaveAccessibleName("Contents of 2024")
		await expectRows(list, ["x.txt", "y.txt"])
		await expectRowSize(list, "y.txt", formatBytes(textBytes("photos/2024/y.txt")))
		await expect(crumbs.getByRole("button", { name: "photos", exact: true })).not.toHaveAttribute("aria-current")

		// Back up by crumb, one level and then the root.
		await crumbs.getByRole("button", { name: "photos", exact: true }).click()
		await expect(crumbs.getByRole("button", { name: "photos", exact: true })).toHaveAttribute("aria-current", "location")
		await expectRows(list, ["2024", "cover.txt"])
		await crumbs.getByRole("button", { name: TREE, exact: true }).click()
		await expectRows(list, ["docs", "empty-dir", "photos", "readme.txt"])

		// Four levels below the root: the top one folds into "…", which still reaches it.
		for (const directory of ["docs", "a", "b", "c"]) {
			await browser.into(directory)
		}

		await expectRows(list, ["deep.txt"])
		await expect(crumbs.getByRole("button", { name: "docs", exact: true })).toHaveCount(0)
		await crumbs.getByRole("button", { name: "Show the directories above", exact: true }).click()
		await page.getByRole("menuitem", { name: "docs", exact: true }).click()
		await expect(crumbs.getByRole("button", { name: "docs", exact: true })).toHaveAttribute("aria-current", "location")
		await expectRows(list, ["a"])

		await crumbs.getByRole("button", { name: TREE, exact: true }).click()
		await expectRows(list, ["docs", "empty-dir", "photos", "readme.txt"])

		// The sort columns say which one is active.
		await expect(browser.sortButton("Name")).toHaveAttribute("aria-pressed", "true")
		await browser.sort("Size")
		await expect(browser.sortButton("Size")).toHaveAttribute("aria-pressed", "true")
		await expect(browser.sortButton("Name")).toHaveAttribute("aria-pressed", "false")

		await browser.into("empty-dir")
		await expect(browser.status("This directory is empty.")).toBeVisible()

		await browser.close()
		expect(cspViolations).toEqual([])
	})

	test("search reaches below the directory shown, and the selection follows the owner's rules", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")
		const browser = await openArchive(page, listbox, TREE)
		const { list, crumbs } = browser
		const searchbox = browser.overlay.getByRole("searchbox", { name: "Search this directory", exact: true })

		await expectRows(list, ["docs", "empty-dir", "photos", "readme.txt"])
		await expect(list).toBeFocused()

		// "/" from the list focuses the search; a match deep down shows the directory it is in.
		await page.keyboard.press("/")
		await expect(searchbox).toBeFocused()
		await page.keyboard.type("deep")
		await expect(browser.row("deep.txt")).toHaveAccessibleName(/(^|\s)docs\/a\/b\/c(\s|$)/)
		await expect(list.getByRole("option")).toHaveCount(1)

		await browser.search("zzz")
		await expect(browser.status("Nothing here matches “zzz”.")).toBeVisible()
		await browser.search("")
		await expectRows(list, ["docs", "empty-dir", "photos", "readme.txt"])

		// One file, then into a directory: navigating clears the selection.
		await browser.into("photos")
		await browser.check(browser.row("cover.txt"))
		await expect(browser.row("cover.txt")).toHaveAttribute("aria-selected", "true")
		await expect(browser.footerSummary()).toHaveText(`1 file selected · ${formatBytes(textBytes("photos/cover.txt"))}`)
		await browser.into("2024")
		await expect(browser.footerSummary()).toHaveText("")

		await browser.check(browser.row("x.txt"))
		await browser.check(browser.row("y.txt"))
		await expect(browser.footerSummary()).toHaveText(
			`2 files selected · ${formatBytes(textBytes("photos/2024/x.txt") + textBytes("photos/2024/y.txt"))}`
		)

		// Mod+A at the root selects every file below it; Escape clears, a second Escape closes.
		await crumbs.getByRole("button", { name: TREE, exact: true }).click()
		await expect(browser.footerSummary()).toHaveText("")
		await list.focus()
		await page.keyboard.press("ControlOrMeta+a")

		const allBytes = Object.values(TREE_FILES).reduce((sum, text) => sum + Buffer.byteLength(text), 0)

		await expect(browser.footerSummary()).toHaveText(`5 files selected · ${formatBytes(allBytes)}`)
		await page.keyboard.press("Escape")
		await expect(browser.footerSummary()).toHaveText("")
		await expect(browser.overlay).toBeVisible()
		await page.keyboard.press("Escape")
		await expect(browser.overlay).toHaveCount(0)

		expect(cspViolations).toEqual([])
	})

	test("the keyboard alone moves, opens, selects, climbs and pages", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")
		const browser = await openArchive(page, listbox, TREE)
		const { list, crumbs } = browser
		const current = crumbs.locator('[aria-current="location"]')

		await expectRows(list, ["docs", "empty-dir", "photos", "readme.txt"])
		await expect(list).toBeFocused()

		await page.keyboard.press("Home")
		await expect(browser.row("docs")).toHaveAttribute("data-cursor", "")
		await page.keyboard.press("Enter")
		await expect(current).toHaveText("docs")
		await expectRows(list, ["a"])

		// Backspace climbs and leaves the cursor on the directory it came from.
		await page.keyboard.press("Backspace")
		await expect(current).toHaveText(TREE)
		await expect(browser.row("docs")).toHaveAttribute("data-cursor", "")
		await page.keyboard.press("Space")
		await expect(browser.row("docs")).toHaveAttribute("aria-selected", "true")
		await page.keyboard.press("Escape")
		await expect(browser.row("docs")).toHaveAttribute("aria-selected", "false")
		await expect(browser.overlay).toBeVisible()

		await page.keyboard.press("ArrowDown")
		await page.keyboard.press("ArrowDown")
		await expect(browser.row("photos")).toHaveAttribute("data-cursor", "")
		await page.keyboard.press("Enter")
		await expect(current).toHaveText("photos")
		await page.keyboard.press("Alt+ArrowUp")
		await expect(current).toHaveText(TREE)
		await expect(browser.row("photos")).toHaveAttribute("data-cursor", "")

		// The list never takes Left/Right: they page the overlay (the tree zip is the scenario's last file).
		await page.keyboard.press("ArrowLeft")
		await expect(list).toHaveAccessibleName(`Contents of ${SMALL}`)
		await expectRows(list, ["small"])

		await browser.close()
		expect(cspViolations).toEqual([])
	})

	test("a hostile zip shows every entry it will not extract, and why", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")
		const browser = await openArchive(page, listbox, HOSTILE)
		const { list } = browser
		const symlink = browser.row("link-to-ok")

		await expect(browser.row("ok.txt")).toBeVisible()
		await expect(symlink).toHaveAccessibleName(/Symbolic link · not extracted/)
		await expect(symlink).toHaveAttribute("aria-disabled", "true")
		// A skipped row cannot be selected, not even through its checkbox.
		await browser.check(symlink)
		await expect(symlink).toHaveAttribute("aria-selected", "false")

		await expect(list.getByRole("option", { name: /escape\.txt.*Unsafe path · not extracted/ })).toBeVisible()
		await expect(list.getByRole("option", { name: /Nested too deeply · not extracted/ })).toBeVisible()
		// The __MACOSX directory is greyed as a whole; its AppleDouble files say why.
		await expect(browser.row("__MACOSX")).toHaveAttribute("aria-disabled", "true")
		await expect(browser.row("._readme.txt")).toHaveAccessibleName(/macOS metadata · not extracted/)
		await expect(browser.row(HOSTILE_MISLEADING_NAME)).toHaveAccessibleName(
			/This name has invisible or direction-changing characters; it may not be what it looks like\./
		)
		await expect(browser.row("dup.txt")).toHaveCount(1)

		const duplicates = browser.status("1 entry is left out because a later entry has the same name.")

		await duplicates.click()
		await expect(browser.overlay.locator("details li", { hasText: "dup.txt" })).toBeVisible()

		// A rooted path is stored as relative, and says what it was.
		await browser.into("abs")
		await expect(browser.row("rooted.txt").locator('[title="Stored as /abs/rooted.txt"]')).toBeVisible()
		await browser.crumbs.getByRole("button", { name: HOSTILE, exact: true }).click()
		await browser.into("__MACOSX")
		await expect(browser.row("._ok.txt")).toHaveAccessibleName(/macOS metadata · not extracted/)

		await browser.close()
		expect(cspViolations).toEqual([])
	})

	test("a ZipCrypto zip lists without its password and checks one when given", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")
		const browser = await openArchive(page, listbox, LOCKED)
		const encryptedBanner = browser.status("Some entries are encrypted. Extracting them needs the password.")
		const wrongBanner = browser.status("That password didn't open the encrypted entries.")

		await expect(browser.row("secret.txt")).toHaveAccessibleName(/(^|\s)Encrypted(\s|$)/)
		await expect(browser.row("inner")).toBeVisible()
		await expect(encryptedBanner).toBeVisible()

		await browser.overlay.getByRole("button", { name: "Enter password", exact: true }).click()
		await browser.unlock("not-the-password")
		await expect(wrongBanner).toBeVisible({ timeout: LISTING_TIMEOUT_MS })

		await browser.overlay.getByRole("button", { name: "Try again", exact: true }).click()
		await expect(archivePasswordPrompt(page)).toContainText(`That password didn't open “${LOCKED}”. Try again.`)
		await browser.unlock(ZIPCRYPTO_PASSWORD)
		await expect(browser.status("Checking the password…")).toHaveCount(0, { timeout: LISTING_TIMEOUT_MS })
		await expect(wrongBanner).toHaveCount(0)
		await expect(encryptedBanner).toHaveCount(0)
		await expect(browser.row("secret.txt")).toBeVisible()

		await browser.close()
		expect(cspViolations).toEqual([])
	})

	test("a tarball's links: symlinks and missing hard links are greyed, a hard link names its target", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")
		const browser = await openArchive(page, listbox, LINKS)
		const { list } = browser

		await expectRows(list, ["dir", "other", "missing-hl", "sym"])
		await expect(browser.row("sym")).toHaveAccessibleName(/Symbolic link · not extracted/)
		await expect(browser.row("sym")).toHaveAttribute("aria-disabled", "true")
		await expect(browser.row("missing-hl")).toHaveAccessibleName(/Hard link to a missing file · not extracted/)
		await expect(browser.row("missing-hl")).toHaveAttribute("aria-disabled", "true")

		await browser.into("dir")

		const hard = browser.row("hard.txt")

		await expect(hard.locator('[title="Points to dir/target.txt"]')).toBeVisible()
		await expect(hard).not.toHaveAttribute("aria-disabled")
		await browser.check(hard)
		await expect(hard).toHaveAttribute("aria-selected", "true")

		await browser.close()
		expect(cspViolations).toEqual([])
	})

	test("small, single-file, empty, damaged and unreadable archives each say what they are", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")
		const browser = await openArchive(page, listbox, CORRUPT)
		const next = browser.overlay.getByRole("button", { name: "Next file", exact: true })
		const tryAgain = browser.overlay.getByRole("button", { name: "Try again", exact: true })

		// Cut short: what was read before the damage stays browsable.
		await expect(browser.status("This archive is damaged.")).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
		await expect(browser.status(/Showing the \d+ entr(y|ies) read before the damage\./)).toBeVisible()
		await expect(tryAgain).toBeVisible()

		await next.click()
		await expect(browser.overlay.getByText(EMPTY)).toBeVisible()
		await expect(browser.status("This archive is empty.")).toBeVisible()

		await next.click()
		await expect(browser.overlay.getByText(GARBAGE)).toBeVisible()
		await expect(browser.status(/^This archive (is damaged|'s format isn't supported)\.$/)).toBeVisible()
		await expect(tryAgain).toBeVisible()

		await browser.close()

		// A single compressed file lists as the one file it holds, named after the archive.
		const single = await openArchive(page, listbox, NOTE)

		await expectRows(single.list, ["e2e-arc-note.txt"])
		await expectRowSize(single.list, "e2e-arc-note.txt", formatBytes(Buffer.byteLength(NOTE_TEXT)))

		// A tarball of 8 MiB or less lists without a gate.
		await single.overlay.getByRole("button", { name: "Next file", exact: true }).click()
		await expect(single.list).toHaveAccessibleName(`Contents of ${SMALL}`)
		await expectRows(single.list, ["small"])
		await expect(single.gate.browse).toHaveCount(0)

		await single.close()
		expect(cspViolations).toEqual([])
	})

	test("a big tarball waits behind its gate, lists on Browse, and comes back from the cache", async ({ page }) => {
		const cspViolations = trackCspViolations(page)
		const egest = observeEgest(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-gate")
		const browser = await openArchive(page, listbox, GATE_NEXT)
		const previous = browser.overlay.getByRole("button", { name: "Previous file", exact: true })
		const next = browser.overlay.getByRole("button", { name: "Next file", exact: true })

		await expectRows(browser.list, ["next.txt"])

		const beforeGate = egest.count()

		await previous.click()
		await expect(browser.gate.body).toBeVisible()
		await expect(browser.gate.browse).toBeVisible()
		await expect(browser.gate.extractAll).toBeVisible()
		// Stepping onto a gated archive reads none of it.
		expect(egest.count()).toBe(beforeGate)

		await browser.gate.browse.click()
		await expect(browser.row("e2e-arc-gate-big")).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
		await browser.into("e2e-arc-gate-big")
		await expectRows(browser.list, ["blob.bin"])
		// The entry shows after the first chunk; only a finished read lets a selection be extracted, and
		// only a finished listing is cached.
		await browser.check(browser.row("blob.bin"))
		await expect(browser.overlay.getByRole("button", { name: "Extract selected", exact: true })).toBeEnabled({
			timeout: LISTING_TIMEOUT_MS
		})
		// Back at the root: the browser reopens an archive where it was left.
		await browser.crumbs.getByRole("button", { name: GATE_BIG, exact: true }).click()
		await expectRows(browser.list, ["e2e-arc-gate-big"])

		// The positive control for the zero above: the context sees the SDK worker's chunk requests.
		expect(egest.count()).toBeGreaterThan(beforeGate)

		await next.click()
		await expectRows(browser.list, ["next.txt"])

		const beforeReturn = egest.count()

		await previous.click()
		await expect(browser.row("e2e-arc-gate-big")).toBeVisible()
		await expect(browser.gate.body).toHaveCount(0)
		expect(egest.count()).toBe(beforeReturn)

		await browser.close()
		expect(cspViolations).toEqual([])
	})

	test("a listing stopped mid-read keeps what it read and lists again", async ({ page, browserName }) => {
		test.skip(browserName === "webkit", "Playwright's WebKit does not route the SDK worker's chunk requests")

		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-gate")
		const browser = await openArchive(page, listbox, GATE_BIG)
		const hold = await holdChunks(page, browserName, { hosts: "egest", passFirst: 1 })

		try {
			await browser.gate.browse.click()
			await expect(browser.status("Reading the archive…").first()).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
			await expect.poll(() => hold?.held() ?? 0, { timeout: LISTING_TIMEOUT_MS }).toBeGreaterThan(0)
			await browser.overlay.getByRole("button", { name: "Stop", exact: true }).click()
			await expect(browser.status(/^Listing stopped after \d+ entr(y|ies)\.$/)).toBeVisible()

			hold?.release()
			await browser.overlay.getByRole("button", { name: "List again", exact: true }).click()
			await expect(browser.row("e2e-arc-gate-big")).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
			await expect(browser.status(/^Listing stopped/)).toHaveCount(0)
		} finally {
			await hold?.dispose()
		}

		await browser.close()
		expect(cspViolations).toEqual([])
	})

	test("closing the overlay mid-listing frees the page's archive slot", async ({ page, browserName }) => {
		test.skip(browserName === "webkit", "Playwright's WebKit does not route the SDK worker's chunk requests")

		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-gate")
		const browser = await openArchive(page, listbox, GATE_BIG)
		const hold = await holdChunks(page, browserName, { hosts: "egest", passFirst: 1 })

		try {
			await browser.gate.browse.click()
			await expect(browser.status("Reading the archive…").first()).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
			await expect.poll(() => hold?.held() ?? 0, { timeout: LISTING_TIMEOUT_MS }).toBeGreaterThan(0)
			await browser.close()
		} finally {
			// The closed listing's held chunk has to come back before its cancel can settle and free the
			// slot; a slot it kept would leave the next archive waiting for good.
			await hold?.dispose()
		}

		const nextBrowser = await openArchive(page, listbox, GATE_NEXT)

		await expectRows(nextBrowser.list, ["next.txt"])
		await expect(nextBrowser.status("Waiting for another archive job")).toHaveCount(0)

		await nextBrowser.close()
		expect(cspViolations).toEqual([])
	})

	test("a 100 000-entry zip lists, selects and scrolls without stalling", async ({ page, browserName }) => {
		const cspViolations = trackCspViolations(page)
		const heapBytes = (): Promise<number> =>
			page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-huge")
		const heapBefore = await heapBytes()
		const browser = await openArchive(page, listbox, HUNDRED_K)
		const { list } = browser

		await expect(browser.row("f000000")).toBeVisible({ timeout: LISTING_TIMEOUT_MS })
		await expect(browser.status("Reading the archive…")).toHaveCount(0, { timeout: LISTING_TIMEOUT_MS })
		await expect(list).toBeFocused()

		await page.keyboard.press("ControlOrMeta+a")
		// However the count is grouped.
		await expect(browser.footerSummary()).toHaveText(/^100[,.\s\u00a0\u202f]?000 files selected · 0 B$/)

		// Long tasks only exist in Chromium's PerformanceObserver; counted from here, over the scrolling.
		await page.evaluate(() => {
			const record = window as unknown as { __archiveLongTasks?: number[] }

			record.__archiveLongTasks = []

			if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
				new PerformanceObserver(entries => {
					for (const entry of entries.getEntries()) {
						record.__archiveLongTasks?.push(entry.duration)
					}
				}).observe({ type: "longtask" })
			}
		})

		await page.keyboard.press("End")
		await expect(browser.row("f099999")).toBeVisible()
		await page.keyboard.press("PageUp")
		await page.keyboard.press("Home")
		await expect(browser.row("f000000")).toBeVisible()

		if (browserName === "chromium") {
			const longTasks = await page.evaluate(() => (window as unknown as { __archiveLongTasks?: number[] }).__archiveLongTasks ?? [])

			expect(longTasks.filter(duration => duration >= 500)).toEqual([])
			expect((await heapBytes()) - heapBefore).toBeLessThan(100 * 1024 * 1024)
		}

		await page.keyboard.press("Escape")
		await browser.close()
		expect(cspViolations).toEqual([])
	})

	test("Open, Browse contents and the pager all lead into the browser", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await bootTo(page)

		const { listbox } = await openFixtureRows(page, "archive-browse")

		for (const via of ["browse", "open"] as const) {
			const browser = await openArchive(page, listbox, TREE, via)

			await expectRows(browser.list, ["docs", "empty-dir", "photos", "readme.txt"])
			await browser.close()
		}

		// The pager steps from archive to archive, each into its own browser.
		const browser = await openArchive(page, listbox, TREE)
		const previous = browser.overlay.getByRole("button", { name: "Previous file", exact: true })

		await expectRows(browser.list, ["docs", "empty-dir", "photos", "readme.txt"])
		await previous.click()
		await expect(browser.list).toHaveAccessibleName(`Contents of ${SMALL}`)
		await previous.click()
		await expect(browser.list).toHaveAccessibleName(`Contents of ${NOTE}`)
		await browser.overlay.getByRole("button", { name: "Next file", exact: true }).click()
		await browser.overlay.getByRole("button", { name: "Next file", exact: true }).click()
		await expect(browser.list).toHaveAccessibleName(`Contents of ${TREE}`)

		await browser.close()

		// The row menu leads with Open, then Extract, on an archive.
		await openRowMenu(page, listbox, TREE)

		const items = page.getByRole("menu").first().getByRole("menuitem")

		await expect(items.nth(0)).toHaveAccessibleName("Open")
		await expect(items.nth(1)).toHaveAccessibleName("Extract")
		await page.keyboard.press("Escape")

		expect(cspViolations).toEqual([])
	})
})
