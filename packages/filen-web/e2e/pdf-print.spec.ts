import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { openFixtureRows } from "./helpers/fixtures"
import { trackCspViolations } from "./helpers/csp"
import { resolveModKey } from "./helpers/modkey"

// Printing a PDF from the viewer: Mod+P opens the print dialog, Print renders the pages into the print root at each
// page's own size, the browser's print dialog opens once every picture decoded, and the root is gone once it closed.
// window.print is replaced before the app boots, so the test reads the root at the moment the dialog would open and
// then closes it (afterprint). Read-only: the shared fixture tree's two-page PDF (two 300 × 400 pt pages).

interface PrintSnapshot {
	readonly pages: number
	readonly sizes: readonly string[]
	// Pictures shown and decoded (Chromium, WebKit), or canvases Firefox draws while printing.
	readonly decoded: number
	readonly canvases: number
	readonly css: string
}

test("PDF prints every page at its size through the print root, cleaned up after the dialog", async ({ page }) => {
	test.setTimeout(300_000)

	const cspViolations = trackCspViolations(page)

	await page.addInitScript(() => {
		const record: { snapshots: unknown[] } = { snapshots: [] }

		Reflect.set(window, "__pdfPrint", record)
		window.print = () => {
			const pages = [...document.querySelectorAll<HTMLElement>(".fo-print-root > .fo-print-page")]

			record.snapshots.push({
				pages: pages.length,
				sizes: pages.map(page => `${page.style.width} ${page.style.height}`),
				decoded: [...document.querySelectorAll<HTMLImageElement>(".fo-print-root img")].filter(
					image => image.complete && image.naturalWidth > 0
				).length,
				canvases: document.querySelectorAll(".fo-print-root canvas").length,
				css: [...document.head.querySelectorAll("style")].map(style => style.textContent).join("")
			})
			window.dispatchEvent(new Event("afterprint"))
		}
	})

	await bootTo(page)

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-pdf-pages")

	await row.dblclick()
	await expect(page.getByRole("region", { name: /Page 1 of 2/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	await page.getByRole("button", { name: "File" }).click()
	await page.getByRole("menuitem", { name: /Print/ }).click()

	const dialog = page.getByRole("dialog", { name: "Print" })

	await expect(dialog).toBeVisible()
	await expect(dialog.getByRole("radio", { name: "All" })).toBeChecked()
	await dialog.getByRole("button", { name: "Print…" }).click()
	await expect(dialog).toBeHidden({ timeout: 60_000 })

	const snapshots = await page.evaluate(() => (Reflect.get(window, "__pdfPrint") as { snapshots: PrintSnapshot[] }).snapshots)

	expect(snapshots).toHaveLength(1)

	const [snapshot] = snapshots

	expect(snapshot?.pages).toBe(2)
	expect(snapshot?.sizes).toEqual(["300pt 400pt", "300pt 400pt"])
	expect((snapshot?.decoded ?? 0) + (snapshot?.canvases ?? 0)).toBe(2)
	expect(snapshot?.css).toContain("size: 300pt 400pt")
	await expect(page.locator(".fo-print-root")).toHaveCount(0)

	// Mod+P opens it again; Cancel closes it without printing.
	await page.getByRole("region", { name: /Page 1 of 2/u }).click()
	await page.keyboard.press(`${await resolveModKey(page)}+p`)
	await expect(dialog).toBeVisible()
	await dialog.getByRole("radio", { name: "Current page (1)" }).check()
	await dialog.getByRole("button", { name: "Cancel" }).click()
	await expect(dialog).toBeHidden()
	expect(await page.evaluate(() => (Reflect.get(window, "__pdfPrint") as { snapshots: unknown[] }).snapshots.length)).toBe(1)

	expect(cspViolations).toEqual([])
})
