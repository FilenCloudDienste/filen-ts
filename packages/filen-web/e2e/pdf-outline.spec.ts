import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	LARGE_UPLOAD_TIMEOUT_MS,
	LAZY_VIEWER_TIMEOUT_MS,
	setDesktopViewport,
	uploadDiskFiles,
	uploadFiles,
	withScratchDirectory
} from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { observeEgest } from "./helpers/requests"
import { writePdf, type PdfObject } from "../scripts/pdf-fixtures/view/pdfWriter"
import { preview } from "@/locales/en/preview"

// The outline of a drive PDF, which opens in the editor's ribbon: the pages rail's Outline tab (the Pages tab's rail
// toggle, then the rail's own tab) lists the bookmarks as a tree, a row goes to its page, the current section follows the
// page shown, and the arrow keys and Enter work the tree. Under the CSP. (The viewer's outline pane, for a document the
// editor does not open, is covered by ebook-view.spec.ts.)
test.describe.configure({ mode: "default" })

const PDF_MIME = "application/pdf"
const PAGES = 12
const CHAPTERS = [0, 4, 8] as const

// PAGES pages, each saying its number, and one bookmark per chapter start ("Chapter 1" on page 1, and so on).
function outlinedPdf(): Uint8Array {
	// 1 catalog, 2 pages, 3 font, 4 outlines, 5.. bookmarks, then a page and its content per page.
	const bookmarkBase = 5
	const pageBase = bookmarkBase + CHAPTERS.length
	const pageRef = (index: number): string => `${String(pageBase + index * 2)} 0 R`
	const objects: PdfObject[] = [
		{ dict: "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>" },
		{
			dict: `<< /Type /Pages /Kids [${Array.from({ length: PAGES }, (_, index) => pageRef(index)).join(" ")}] /Count ${String(PAGES)} >>`
		},
		{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
		{
			dict: `<< /Type /Outlines /First ${String(bookmarkBase)} 0 R /Last ${String(bookmarkBase + CHAPTERS.length - 1)} 0 R /Count ${String(CHAPTERS.length)} >>`
		}
	]

	CHAPTERS.forEach((page, index) => {
		const previous = index > 0 ? `/Prev ${String(bookmarkBase + index - 1)} 0 R` : ""
		const next = index < CHAPTERS.length - 1 ? `/Next ${String(bookmarkBase + index + 1)} 0 R` : ""

		objects.push({
			dict: `<< /Title (Chapter ${String(index + 1)}) /Parent 4 0 R ${previous} ${next} /Dest [${pageRef(page)} /XYZ null null null] >>`
		})
	})

	for (let index = 0; index < PAGES; index++) {
		objects.push({
			dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageBase + index * 2 + 1)} 0 R >>`
		})
		objects.push({ dict: "<< >>", stream: new TextEncoder().encode(`BT /F1 24 Tf 72 760 Td (Page ${String(index + 1)}) Tj ET`) })
	}

	return writePdf(objects, 1)
}

// The editor's left rail on its Outline tab, opened from the ribbon's Pages tab where it is closed; its tree.
async function openOutlineRail(page: Page): Promise<{ readonly rail: Locator; readonly tree: Locator }> {
	const rail = page.getByRole("complementary", { name: preview.previewPdfPagesRailToggle })

	if ((await rail.count()) === 0) {
		// The ribbon's Pages tab, before the rail (whose own Pages tab follows it in the document).
		await page.getByRole("tab", { name: preview.previewPdfTabPages, exact: true }).first().click()
		await page.getByRole("button", { name: preview.previewPdfPagesRailToggle }).click()
	}

	await rail.getByRole("tab", { name: preview.previewPdfOutlineTabOutline }).click()

	return { rail, tree: rail.getByRole("tree", { name: preview.previewPdfOutlinePane }) }
}

// The page the view went to: its top at the pages' top, so it is on screen in a normal window.
function shownPage(page: Page, number: number): Locator {
	return page.locator(`[data-page="${String(number)}"]`)
}

test("the outline goes to a chapter, follows the page and works with the keys", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)

	await page.setViewportSize({ width: 1280, height: 900 })

	await withScratchDirectory(page, "pdf-outline", async ({ listbox, runId }) => {
		const name = `e2e-pdf-outline-${runId}.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: Buffer.from(outlinedPdf()) }], listbox)
		await setDesktopViewport(page)
		await listbox.getByRole("option", { name }).dblclick()
		await expect(page.getByRole("region", { name: new RegExp(`Page 1 of ${String(PAGES)}`, "u") })).toBeVisible({
			timeout: LAZY_VIEWER_TIMEOUT_MS
		})

		const { rail, tree } = await openOutlineRail(page)

		await expect(tree.getByRole("treeitem")).toHaveCount(CHAPTERS.length)
		await expect(tree.getByRole("treeitem", { name: "Chapter 1" })).toHaveAttribute("aria-current", "location")

		await tree.getByRole("treeitem", { name: "Chapter 3" }).click()
		await expect(shownPage(page, 9)).toBeInViewport()
		await expect(shownPage(page, 1)).not.toBeInViewport()
		await expect(tree.getByRole("treeitem", { name: "Chapter 3" })).toHaveAttribute("aria-current", "location")

		// The keys: up to Chapter 2, Enter goes there.
		await page.keyboard.press("ArrowUp")
		await expect(tree.getByRole("treeitem", { name: "Chapter 2" })).toBeFocused()
		await page.keyboard.press("Enter")
		await expect(shownPage(page, 5)).toBeInViewport()
		await expect(tree.getByRole("treeitem", { name: "Chapter 2" })).toHaveAttribute("aria-current", "location")

		// Back to the thumbnails: the tree goes.
		await rail.getByRole("tab", { name: preview.previewPdfOutlineTabPages }).click()
		await expect(tree).toHaveCount(0)
	})

	expect(cspViolations).toEqual([])
})

// A ranged file whose bookmarks lead through named destinations, the name tree's leaves one per SDK chunk (1 MiB of
// filler between them): resolving a bookmark reads its leaf's chunk (and the leaves a lookup passes on its way).
const RANGED_BOOKMARKS = 200
const NAMES_PER_LEAF = 4
const RANGED_LEAVES = RANGED_BOOKMARKS / NAMES_PER_LEAF
const RANGED_PAGES = 8
const CHUNK = 1024 * 1024
const ROW_PX = 28
// The rows the pane resolves past those on screen, each way (pdfOutline.logic OUTLINE_RESOLVE_MARGIN).
const RESOLVE_MARGIN = 20

function destName(index: number): string {
	return `d${String(index).padStart(4, "0")}`
}

function rangedOutlinePdf(): Uint8Array {
	// 1 catalog, 2 pages, 3 font, 4 outlines, 5 name tree root, 6.. bookmarks, then the pages and their contents, then
	// per leaf a filler stream and the leaf.
	const bookmarkBase = 6
	const pageBase = bookmarkBase + RANGED_BOOKMARKS
	const leafBase = pageBase + RANGED_PAGES * 2
	const pageRef = (index: number): string => `${String(pageBase + index * 2)} 0 R`
	const leafRef = (leaf: number): string => `${String(leafBase + leaf * 2 + 1)} 0 R`
	const objects: PdfObject[] = [
		{ dict: "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /Names << /Dests 5 0 R >> >>" },
		{
			dict: `<< /Type /Pages /Kids [${Array.from({ length: RANGED_PAGES }, (_, index) => pageRef(index)).join(" ")}] /Count ${String(RANGED_PAGES)} >>`
		},
		{ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
		{
			dict: `<< /Type /Outlines /First ${String(bookmarkBase)} 0 R /Last ${String(bookmarkBase + RANGED_BOOKMARKS - 1)} 0 R /Count ${String(RANGED_BOOKMARKS)} >>`
		},
		{ dict: `<< /Kids [${Array.from({ length: RANGED_LEAVES }, (_, leaf) => leafRef(leaf)).join(" ")}] >>` }
	]

	for (let index = 0; index < RANGED_BOOKMARKS; index++) {
		const previous = index > 0 ? `/Prev ${String(bookmarkBase + index - 1)} 0 R` : ""
		const next = index < RANGED_BOOKMARKS - 1 ? `/Next ${String(bookmarkBase + index + 1)} 0 R` : ""

		objects.push({ dict: `<< /Title (Section ${String(index + 1)}) /Parent 4 0 R ${previous} ${next} /Dest (${destName(index)}) >>` })
	}

	for (let index = 0; index < RANGED_PAGES; index++) {
		objects.push({
			dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageBase + index * 2 + 1)} 0 R >>`
		})
		objects.push({ dict: "<< >>", stream: new TextEncoder().encode(`BT /F1 24 Tf 72 760 Td (Page ${String(index + 1)}) Tj ET`) })
	}

	for (let leaf = 0; leaf < RANGED_LEAVES; leaf++) {
		const first = leaf * NAMES_PER_LEAF
		const names = Array.from({ length: NAMES_PER_LEAF }, (_, offset) => {
			const index = first + offset

			return `(${destName(index)}) [${pageRef(index % RANGED_PAGES)} /XYZ null null null]`
		})

		objects.push({ dict: "<< >>", stream: new Uint8Array(CHUNK).fill(0x20) })
		objects.push({
			dict: `<< /Limits [(${destName(first)}) (${destName(first + NAMES_PER_LEAF - 1)})] /Names [${names.join(" ")}] >>`
		})
	}

	return writePdf(objects, 1)
}

test("the outline resolves the destinations of the rows near the view only, on a ranged file", async ({ page }) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	// Over Playwright's 50 MB limit for an in-memory upload: written to disk and uploaded from there.
	const bytes = rangedOutlinePdf()
	const chunks = Math.ceil(bytes.length / CHUNK)
	const dir = mkdtempSync(join(tmpdir(), "filen-e2e-outline-"))

	await page.setViewportSize({ width: 1280, height: 900 })

	try {
		await withScratchDirectory(page, "pdf-outline-ranged", async ({ listbox, runId }) => {
			const name = `e2e-pdf-outline-ranged-${runId}.pdf`

			const path = join(dir, name)

			writeFileSync(path, bytes)
			await uploadDiskFiles(page, [path], listbox)

			const egest = observeEgest(page.context())

			await setDesktopViewport(page)
			await listbox.getByRole("option", { name }).dblclick()
			await expect(page.locator('[data-page="1"][data-rendered="true"]')).toBeAttached({ timeout: LARGE_UPLOAD_TIMEOUT_MS })

			// What opening read settles first; from here every chunk is the pane's.
			await expect
				.poll(async () => {
					const before = egest.requests()

					await page.waitForTimeout(1500)

					return egest.requests() - before
				})
				.toBe(0)
			egest.reset()

			const { tree } = await openOutlineRail(page)

			await expect(tree.getByRole("treeitem", { name: "Section 1", exact: true })).toBeVisible()

			// Settled: no chunk for a while. The rows resolve one at a time, each a chunk download behind the last, so
			// settling takes longer than the default poll on a slow runner.
			await expect
				.poll(
					async () => {
						const before = egest.requests()

						await page.waitForTimeout(1500)

						return egest.requests() - before
					},
					{ timeout: LAZY_VIEWER_TIMEOUT_MS }
				)
				.toBe(0)

			const rows = Math.ceil((await tree.evaluate(element => element.clientHeight)) / ROW_PX) + 2 * RESOLVE_MARGIN
			// The leaves of the rows resolved, and the leaves a binary search of the name tree passes through.
			const bound = Math.ceil(rows / NAMES_PER_LEAF) + Math.ceil(Math.log2(RANGED_LEAVES)) + 2

			expect(egest.requests()).toBeLessThanOrEqual(bound)
			expect(egest.requests()).toBeLessThan(chunks / 2)

			// The rows' destinations resolved: a bookmark near the top goes to its page.
			await tree.getByRole("treeitem", { name: "Section 3", exact: true }).click()
			await expect(shownPage(page, 3)).toBeInViewport()
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}

	expect(cspViolations).toEqual([])
})
