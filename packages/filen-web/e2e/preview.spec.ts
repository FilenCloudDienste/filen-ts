import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"

// Proves the preview overlay's whole pager loop live: open via double-click, page forward with the
// on-screen button, page back with the ArrowLeft key (the in-dialog local handler — see
// preview-overlay.tsx's own onKeyDown comment for why a document-level keymap action can't reach it),
// close with Escape. The two PNG fixtures live inside a per-run scratch directory (mirrors
// downloads.spec.ts's own enterScratchDirectory/trashScratchDirectory convention) rather than at
// /drive's root — this suite runs fullyParallel (playwright.config.ts), and a root-level create/trash
// races drive.spec.ts's own root-listing assertions (see drive-actions.spec.ts's comment for the exact
// failure this once produced live).
const FIREFOX_HANG_REASON = "drive listing needs an authenticated listDir call, which hangs indefinitely on Playwright-firefox under COI"

// A real 1x1 transparent PNG.
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

// A real, tiny (505-byte) HEIC image — an 8x8 solid-red still picture, HEVC-encoded. Small enough to
// embed as base64 like the PNG fixture above, and genuinely decodable (verified against the exact
// libheif-js build this app lazy-loads before committing this fixture).
const HEIC_BYTES = Buffer.from(
	"AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAOZpcHJwAAAAxWlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAACAAAAAgAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMAAAMAHqAUIEHAmw7iHuRZVNwICBgCogABAAlEAcBhcshEU2QAAAAZaXBtYQAAAAAAAAABAAEGgQIDBYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAboAAAA/AAAAAW1kYXQAAAAAAAAATwAAADsoAa+i+kaBfP/92s//9uX7L9AKPVf/tCfI+buy/6ZQ90yyZ/og+cI53hzw5nPv9uVCL2FfgrcISbIrgA==",
	"base64"
)

// Duplicated from downloads.spec.ts rather than shared — this package has no cross-spec e2e helpers
// module yet, and every other spec file here owns its helpers locally too.
async function waitForListingSettled(page: Page): Promise<{ listbox: ReturnType<Page["getByRole"]>; hasItems: boolean }> {
	const listbox = page.getByRole("listbox", { name: "Directory contents" })
	const empty = page.getByText("Nothing here yet")

	await expect(listbox.or(empty)).toBeVisible()

	return { listbox, hasItems: await listbox.isVisible() }
}

// Duplicated from downloads.spec.ts's own enterScratchDirectory — same rationale (a generous viewport
// defeats virtualization so a later named-row locator can't miss a mounted-but-scrolled row; dblclick
// descends via a real client-side route change).
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

// Duplicated from downloads.spec.ts's own trashScratchDirectory — Escape first defensively closes the
// preview overlay if a failed assertion above left it open (its own onOpenChange never otherwise runs),
// same rationale as that file's popover-dismiss comment.
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

test("image preview opens, pages with the button and the arrow key, and closes with escape", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-${runId}`
	const nameA = `e2e-preview-a-${runId}.png`
	const nameB = `e2e-preview-b-${runId}.png`

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([
			{ name: nameA, mimeType: "image/png", buffer: PNG_BYTES },
			{ name: nameB, mimeType: "image/png", buffer: PNG_BYTES }
		])

		const rowA = listbox.getByRole("option", { name: nameA })
		const rowB = listbox.getByRole("option", { name: nameB })
		await expect(rowA).toBeVisible({ timeout: 45_000 })
		await expect(rowB).toBeVisible({ timeout: 45_000 })

		// Open the first image — the overlay renders it (worker round trip -> generous timeout).
		await rowA.dblclick()
		const imgA = page.getByRole("img", { name: nameA })
		await expect(imgA).toBeVisible({ timeout: 30_000 })

		// The on-screen next button pages forward (isolates the pager machinery from the key path).
		await page.getByRole("button", { name: "Next file" }).click()
		const imgB = page.getByRole("img", { name: nameB })
		await expect(imgB).toBeVisible({ timeout: 30_000 })

		// The arrow key pages back (isolates the in-dialog local keydown path).
		await page.keyboard.press("ArrowLeft")
		await expect(imgA).toBeVisible({ timeout: 15_000 })

		// Escape closes the overlay entirely.
		await page.keyboard.press("Escape")
		await expect(imgA).toHaveCount(0)
		await expect(page.getByRole("img", { name: nameB })).toHaveCount(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

// The one live proof the HEIC path actually decodes: a real WASM library, lazy-loaded on first HEIC
// preview, running in a real browser — unlike the pure logic seams (preview.logic.test.ts,
// media-type.test.ts, heic-transform.test.ts), an injected/mocked decoder can't prove this. Also
// proves the buffered-not-streamed guarantee end to end (the img's own src) and zero CSP violations
// during the WASM load + decode (the CSP concession this feature could have needed, but didn't).
test("HEIC preview transforms client-side and renders via the buffered path, never the SW route", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-heic-${runId}`
	const nameHeic = `e2e-preview-heic-${runId}.heic`

	const cspViolations: string[] = []
	page.on("console", msg => {
		if (msg.type() === "error" && /content security policy|refused to/i.test(msg.text())) {
			cspViolations.push(msg.text())
		}
	})

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameHeic, mimeType: "image/heic", buffer: HEIC_BYTES }])

		const row = listbox.getByRole("option", { name: nameHeic })
		await expect(row).toBeVisible({ timeout: 45_000 })

		// The WASM decoder is lazy-loaded here for the first time (fetch + compile + decode + a JPEG
		// re-encode), on top of the worker round trip every buffered preview already pays — a generous
		// timeout accounts for that, not just the download.
		await row.dblclick()
		const img = page.getByRole("img", { name: nameHeic })
		await expect(img).toBeVisible({ timeout: 60_000 })

		// Buffered path only, never the SW's inline route (needsImageTransform's own unit test proves
		// the logic-layer guarantee; this is the same guarantee observed live).
		const src = await img.getAttribute("src")
		expect(src).toMatch(/^blob:/)

		await page.keyboard.press("Escape")
		await expect(img).toHaveCount(0)

		expect(cspViolations).toEqual([])
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
