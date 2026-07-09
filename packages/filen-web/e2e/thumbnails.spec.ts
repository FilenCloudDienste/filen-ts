import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"

// Duplicated from preview.spec.ts/downloads.spec.ts rather than shared — this package has no
// cross-spec e2e helpers module yet, and every other spec file here owns its helpers locally too.
const FIREFOX_HANG_REASON = "drive listing needs an authenticated listDir call, which hangs indefinitely on Playwright-firefox under COI"

// A real 1x1 transparent PNG — the same fixture preview.spec.ts uses for its own image-preview leg.
// canMakeThumbnail is metadata-only (extension-derived), but makeThumbnailInMemory itself decodes
// real bytes, so this has to be a genuinely valid image, not just a correctly-named one.
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

async function waitForListingSettled(page: Page): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	const listbox = page.getByRole("listbox", { name: "Directory contents" })
	const empty = page.getByText("Nothing here yet")

	await expect(listbox.or(empty)).toBeVisible()

	return { listbox, hasItems: await listbox.isVisible() }
}

// Duplicated from downloads.spec.ts's own enterScratchDirectory — same rationale (a generous
// viewport defeats virtualization so a later named-row locator can't miss a mounted-but-scrolled
// row; dblclick descends via a real client-side route change).
async function enterScratchDirectory(page: Page, name: string): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	await page.setViewportSize({ width: 1280, height: 8000 })

	const { listbox } = await waitForListingSettled(page)

	await page.getByRole("button", { name: "New directory", exact: true }).click()
	const dialog = page.getByRole("dialog")
	await expect(dialog).toBeVisible()
	await page.getByLabel("Name", { exact: true }).fill(name)
	await page.getByRole("button", { name: "Create", exact: true }).click()
	await expect(dialog).toHaveCount(0)

	const scratchRow = listbox.getByRole("option", { name })
	await expect(scratchRow).toBeVisible()

	await scratchRow.dblclick()

	return waitForListingSettled(page)
}

// Duplicated from downloads.spec.ts's own trashScratchDirectory — Escape first defensively closes
// any popover/overlay a failed assertion above left open.
async function trashScratchDirectory(page: Page, name: string): Promise<void> {
	await page.keyboard.press("Escape")
	await page.getByRole("complementary").getByRole("link", { name: "My Drive", exact: true }).click()

	const { listbox } = await waitForListingSettled(page)
	const row = listbox.getByRole("option", { name })

	try {
		await expect(row).toBeVisible({ timeout: 15_000 })
	} catch {
		return
	}

	await row.click()
	await page.getByRole("button", { name: "Trash", exact: true }).click()

	const confirm = page.getByRole("alertdialog")
	await expect(confirm).toBeVisible()
	await confirm.getByRole("button", { name: "Trash", exact: true }).click()
	await expect(confirm).toHaveCount(0)
}

// The one live proof the whole thumbnail pipeline works end to end: a real makeThumbnailInMemory
// worker round trip, a real OPFS write/read, and the icon-slot swap in both listing views — none of
// that is provable at the unit level (thumbnails.test.ts/thumbnails.logic.test.ts inject every
// collaborator). Also the one deliberate reload in this suite (every other spec stays client-nav):
// proves the OPFS cache survives a real cold document boot, not just a component remount.
test("an image renders a real thumbnail in both listing views, text/svg siblings keep their icon, and a fresh reload repaints from the OPFS cache without regenerating", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-thumbnails-${runId}`
	const namePng = `e2e-thumb-${runId}.png`
	const nameTxt = `e2e-thumb-${runId}.txt`
	const nameSvg = `e2e-thumb-${runId}.svg`

	const cspViolations: string[] = []
	page.on("console", msg => {
		if (msg.type() === "error" && /content security policy|refused to/i.test(msg.text())) {
			cspViolations.push(msg.text())
		}
	})

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		// The scratch directory's own uuid, off the URL the descent above just navigated to (mirrors
		// drive.spec.ts's own subdirectory-navigation assertion) — needed below to probe its thumbnail's
		// on-disk cache entry by (parent, name) rather than by a uuid this test never otherwise sees.
		const scratchUuid = /\/drive\/([^/]+)$/.exec(page.url())?.[1]

		if (scratchUuid === undefined) {
			throw new Error("scratch directory did not navigate to a uuid'd url")
		}

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([
			{ name: namePng, mimeType: "image/png", buffer: PNG_BYTES },
			{ name: nameTxt, mimeType: "text/plain", buffer: Buffer.from("not an image", "utf8") },
			{ name: nameSvg, mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8") }
		])

		const rowPng = listbox.getByRole("option", { name: namePng })
		const rowTxt = listbox.getByRole("option", { name: nameTxt })
		const rowSvg = listbox.getByRole("option", { name: nameSvg })
		await expect(rowPng).toBeVisible({ timeout: 45_000 })
		await expect(rowTxt).toBeVisible({ timeout: 45_000 })
		await expect(rowSvg).toBeVisible({ timeout: 45_000 })

		// The PNG's icon slot swaps to a real <img> once the worker round trip resolves — a generous
		// timeout covers the makeThumbnailInMemory call, not just the upload that already landed the
		// row. alt="" makes this element decorative (no accessible "img" role), so it's found by tag,
		// not role.
		const pngThumbList = rowPng.locator("img")
		await expect(pngThumbList).toBeVisible({ timeout: 30_000 })
		await expect(pngThumbList).toHaveAttribute("src", /^blob:/)

		// Neither sibling ever gets an <img>: no extension routes a .txt to any thumbnail category, and
		// svg is excluded outright (sanitization risk, kept an icon everywhere this app renders one) —
		// their icon element is never replaced.
		await expect(rowTxt.locator("img")).toHaveCount(0)
		await expect(rowSvg.locator("img")).toHaveCount(0)

		// Grid view renders the identical thumbnail through a different slot (DriveTile, not DriveRow) —
		// the service's own uuid-keyed url cache makes this a render-path proof, not a second generation.
		await page.getByRole("button", { name: "Grid view", exact: true }).click()
		await expect(page.getByRole("button", { name: "Grid view", exact: true })).toHaveAttribute("aria-pressed", "true")

		const tilePng = page.getByRole("option", { name: namePng })
		const pngThumbGrid = tilePng.locator("img")
		await expect(pngThumbGrid).toBeVisible({ timeout: 15_000 })
		await expect(pngThumbGrid).toHaveAttribute("src", /^blob:/)

		await page.getByRole("button", { name: "List view", exact: true }).click()

		const statBeforeReload = await page.evaluate(({ parentUuid, name }) => window.__filenE2E.thumbnailFileStat(parentUuid, name), {
			parentUuid: scratchUuid,
			name: namePng
		})
		expect(statBeforeReload).not.toBeNull()

		// The one deliberate reload in this suite: a fresh document, same session — proves the OPFS
		// cache round-trips across a real cold boot, not just a component remount within the same page.
		// Reloads to /drive (root), never straight to the scratch directory's own uuid'd url: the
		// injected-session fixture's addInitScript reseeds sessionStorage on EVERY navigation, and the
		// app's own seedFromSlot unconditionally re-navigates to "/" once it replays that seed — which
		// index.tsx resolves to the bare drive root regardless of what url was actually requested, so a
		// direct goto to a nested path is silently overridden (reproduced live: it lands back at root,
		// not the deep link). Re-entering by name below still exercises a genuine cold document boot.
		await page.goto("/drive")
		const { listbox: rootListboxAfterReload } = await waitForListingSettled(page)
		await rootListboxAfterReload.getByRole("option", { name: scratchName }).dblclick()
		const { listbox: listboxAfterReload } = await waitForListingSettled(page)

		const rowPngAfterReload = listboxAfterReload.getByRole("option", { name: namePng })
		await expect(rowPngAfterReload).toBeVisible({ timeout: 15_000 })
		const pngThumbAfterReload = rowPngAfterReload.locator("img")
		await expect(pngThumbAfterReload).toBeVisible({ timeout: 30_000 })
		await expect(pngThumbAfterReload).toHaveAttribute("src", /^blob:/)

		const statAfterReload = await page.evaluate(({ parentUuid, name }) => window.__filenE2E.thumbnailFileStat(parentUuid, name), {
			parentUuid: scratchUuid,
			name: namePng
		})

		// Identical size AND lastModified proves the OPFS file was never rewritten between the two loads
		// — a real regeneration always truncates + rewrites (writeThumb), which would bump
		// lastModified; a pure cache-hit read never touches that path.
		expect(statAfterReload).toEqual(statBeforeReload)

		expect(cspViolations).toEqual([])
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
