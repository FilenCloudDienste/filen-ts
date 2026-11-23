import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { test, expect, settleLeases } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { resolveModKey } from "./helpers/modkey"
import { expectPdfSaved, pdfLiveRegion, pdfPageScroller } from "./helpers/pdfSurface"
import { preview } from "@/locales/en/preview"
import { settings } from "@/locales/en/settings"

// Fill & Sign in a real browser: text and marks placed on a page (by pointer and by keyboard), a signature drawn with
// the pointer (and touch on the mobile WebKit viewport), saved for reuse and offered again in the next document,
// initials typed, and the saved signature deleted in Settings › Office. The saved file is read back by pdf.js. Fixture: @filen/office's
// acroform.pdf (src/scripts/pdfFormFixtures.ts).

test.describe.configure({ mode: "default" })

const FIXTURE = new URL("../../filen-office/src/tests/fixtures/pdfforms/acroform.pdf", import.meta.url)
const PDF_MIME = "application/pdf"
const SWAP_TIMEOUT_MS = 60_000
// Reading the account's synced saved signatures (one small file): an upper bound only, the row says when it has.
const SAVED_SIGNATURES_READ_MS = 60_000

async function open(page: Page, listbox: Locator, name: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(page.getByRole("region", { name: /Page 1 of/u })).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function close(page: Page): Promise<void> {
	// Escape from the document: in the ribbon (where focus goes back once a tool's dialog closes) it returns to the pages.
	await pdfPageScroller(page.getByRole("dialog").first()).focus()

	// Diagnostic (WebKit has kept the viewer open here): where focus was when Escape was pressed.
	const focused = await page.evaluate(() => {
		const element = document.activeElement

		return element === null
			? "(none)"
			: `<${element.tagName.toLowerCase()} role=${element.getAttribute("role") ?? ""} label=${element.getAttribute("aria-label") ?? ""}> in dialog: ${String(element.closest('[role="dialog"]') !== null)}`
	})

	await page.keyboard.press("Escape")
	await expect(page.getByRole("region", { name: /Page 1 of/u }))
		.toHaveCount(0)
		.catch(async (error: unknown) => {
			await test.info().attach("focus-before-escape", { body: focused, contentType: "text/plain" })
			throw error
		})
}

async function downloaded(page: Page): Promise<Buffer> {
	const downloading = page.waitForEvent("download")

	await page.getByRole("button", { name: preview.previewDownloadAction, exact: true }).click()

	return readFileSync(await (await downloading).path())
}

interface AnnotationInfo {
	readonly subtype: string
	readonly rect: readonly number[]
	readonly subject: string | null
}

// The annotations per page (no form widgets), as pdf.js reads them.
async function annotationInfos(bytes: Buffer): Promise<AnnotationInfo[][]> {
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
	const pdf = await task.promise
	const pages: AnnotationInfo[][] = []

	for (let index = 1; index <= pdf.numPages; index++) {
		const annotations = (await (await pdf.getPage(index)).getAnnotations()) as {
			subtype: string
			rect: number[]
			subject?: { str?: string } | null
		}[]

		pages.push(
			annotations
				.filter(annotation => annotation.subtype !== "Widget")
				.map(annotation => ({ subtype: annotation.subtype, rect: annotation.rect, subject: annotation.subject?.str ?? null }))
		)
	}

	await task.destroy()

	return pages
}

// A signature-like scribble across the drawing area, with the mouse or (on a touch viewport) a finger.
async function scribble(page: Page, pad: Locator): Promise<void> {
	const box = await pad.boundingBox()

	if (box === null) throw new Error("drawing area not laid out")

	const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy]
	const points = [at(0.1, 0.6), at(0.25, 0.3), at(0.4, 0.7), at(0.55, 0.3), at(0.7, 0.7), at(0.9, 0.4)]
	const [startX, startY] = points[0] ?? at(0, 0)

	await page.mouse.move(startX, startY)
	await page.mouse.down()

	for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 6 })

	await page.mouse.up()
}

// Settings › Office: every saved signature and initials deleted (they live with the account, so a run that stopped
// early leaves its own behind), until the row says there are none.
async function clearSavedSignatures(page: Page): Promise<void> {
	await bootTo(page, "/settings/office")
	await expect(page.getByText(settings.settingsOfficePdfSavingNote)).toBeVisible()

	const none = page.getByText(settings.settingsOfficeSavedSignaturesNone, { exact: true })
	const manage = page.getByRole("button", { name: settings.settingsOfficeSavedSignaturesManageLabel })
	// The row is aria-busy until the synced file is read; then a disabled Manage means there are none.
	const row = manage.locator("xpath=..")

	await expect(row).not.toHaveAttribute("aria-busy", "true", { timeout: SAVED_SIGNATURES_READ_MS })

	if (await manage.isDisabled()) {
		await expect(none).toBeVisible()

		return
	}

	await manage.click()

	const dialog = page.getByRole("dialog", { name: settings.settingsOfficeSavedSignaturesDialogTitle })
	const remove = dialog.getByRole("button", { name: /^Delete (signature|initials) \d+$/u })

	await expect(dialog).toBeVisible()

	while ((await remove.count()) > 0) {
		const left = await remove.count()

		await remove.first().click()
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: settings.settingsOfficeSavedSignaturesDeleteConfirm, exact: true })
			.click()
		await expect(remove).toHaveCount(left - 1, { timeout: LIVE_WRITE_TIMEOUT_MS })
		// The list drops the entry at once; the synced file is uploaded after it, and a navigation before that upload
		// ends loses the delete (the next boot reads the file as it was). The upload is already under way by the time
		// the list shows the drop (syncedDotFilenFile.ts starts it in the same task), so it is waited out by the SDK
		// call itself, never by a lease request: the SDK reuses a drive-write lease it still holds without asking again.
		await expect
			.poll(() => page.evaluate(() => window.__filenE2E.pendingSdkCalls().filter(call => call.method === "uploadFileBytes").length), {
				timeout: LIVE_WRITE_TIMEOUT_MS
			})
			.toBe(0)
		await settleLeases(page)
	}

	await page.keyboard.press("Escape")
	await expect(dialog).toHaveCount(0)
	await expect(none).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
}

function fillSignTab(page: Page): Locator {
	return page.getByRole("tab", { name: "Fill & Sign" })
}

test("Fill & Sign: text, marks and a drawn signature are saved; the signature is offered again and deletable", async ({
	page
}, testInfo) => {
	test.slow()

	const cspViolations = trackCspViolations(page)
	const mod = await resolveModKey(page)

	// The first signature drawn here is the account's only one (the dialog offers the pad, not a saved one).
	await clearSavedSignatures(page)
	await withScratchDirectory(page, "pdf-fill-sign", async ({ listbox, runId }) => {
		const first = `e2e-${runId}-first.pdf`
		const second = `e2e-${runId}-second.pdf`

		await uploadFiles(
			page,
			[
				{ name: first, mimeType: PDF_MIME, buffer: readFileSync(FIXTURE) },
				{ name: second, mimeType: PDF_MIME, buffer: readFileSync(FIXTURE) }
			],
			listbox
		)

		await open(page, listbox, first)
		await fillSignTab(page).click()

		// While a Fill & Sign tool is active each page is a surface to place on.
		const pageSurface = page.getByRole("application", { name: preview.previewPdfFillPlaceOnPage.replace("{{page}}", "2") })

		await page.getByRole("button", { name: preview.previewPdfFillText }).click()
		await pageSurface.click({ position: { x: 300, y: 120 }, timeout: SWAP_TIMEOUT_MS })
		await page.getByRole("textbox", { name: preview.previewPdfFillTextLabel }).fill("Signed in Berlin")
		await page.keyboard.press("Enter")
		await page.getByRole("button", { name: preview.previewPdfFillCheck }).click()
		await pageSurface.click({ position: { x: 120, y: 220 } })

		// A cross placed from the keyboard: Enter puts it at the page's centre, arrows move it, Enter places it.
		// Each step is said in the editor's live region ("left, top pt, width × height pt").
		await page.getByRole("button", { name: preview.previewPdfFillCross }).click()
		// Diagnostic (Chromium CI: focus ended on the preview dialog before this Enter, the editor long ready): every
		// focus move from here, and whether the page surface focused below is the one still shown or was replaced.
		await page.evaluate(() => {
			const moves: string[] = []
			const describe = (node: EventTarget | null): string =>
				node instanceof Element
					? `<${node.tagName.toLowerCase()} role=${node.getAttribute("role") ?? ""} label=${node.getAttribute("aria-label") ?? ""}>`
					: "(none)"

			Reflect.set(window, "__e2eFocusMoves", moves)

			for (const type of ["focusin", "focusout"]) {
				document.addEventListener(
					type,
					event => {
						moves.push(
							`${String(Math.round(performance.now()))} ${type} ${describe(event.target)} -> ${describe((event as FocusEvent).relatedTarget)}`
						)
					},
					true
				)
			}
		})
		await pageSurface.focus()
		await pageSurface.evaluate(element => {
			element.setAttribute("data-e2e-focused", "")
		})
		await page.keyboard.press("Enter")

		const live = pdfLiveRegion(page.getByRole("dialog").first())
		const position = /^\d+, \d+ pt, \d+ × \d+ pt$/u

		await expect(live)
			.toHaveText(position)
			.catch(async (error: unknown) => {
				const report = await page.evaluate(() => {
					const element = document.activeElement
					const marked = document.querySelector("[data-e2e-focused]")
					const moves = (Reflect.get(window, "__e2eFocusMoves") as string[] | undefined) ?? []

					return [
						`active: ${element === null ? "(none)" : `<${element.tagName.toLowerCase()} role=${element.getAttribute("role") ?? ""} label=${element.getAttribute("aria-label") ?? ""}>`}`,
						`the surface focused is ${marked === null ? "gone (replaced)" : "still shown"}`,
						...moves
					].join("\n")
				})

				await testInfo.attach("cross-placement-focus", { body: report, contentType: "text/plain" })
				throw error
			})

		const started = await live.textContent()

		await page.keyboard.press("Shift+ArrowRight")
		await expect(live).not.toHaveText(started ?? "")
		await expect(live).toHaveText(position)
		await page.keyboard.press("Enter")

		// A drawn signature, saved for reuse.
		await page.getByRole("button", { name: preview.previewPdfFillSignature }).click()

		const dialog = page.getByRole("dialog", { name: preview.previewPdfSignatureDialogTitle })
		const pad = dialog.getByRole("img", { name: preview.previewPdfSignaturePad })

		await scribble(page, pad)
		await expect(pad).toHaveAttribute("data-strokes", "1")
		await dialog.getByRole("button", { name: preview.previewPdfSignatureUndoStroke }).click()
		await expect(pad).toHaveAttribute("data-strokes", "0")
		await scribble(page, pad)
		await expect(dialog.getByLabel(preview.previewPdfSignatureSaveForReuse)).toBeChecked()
		await dialog.getByRole("button", { name: preview.previewPdfSignaturePlace }).click()
		await expect(dialog).toHaveCount(0)
		await pageSurface.click({ position: { x: 200, y: 350 }, timeout: SWAP_TIMEOUT_MS })

		// Initials typed.
		await page.getByRole("button", { name: preview.previewPdfFillInitials }).click()

		const initials = page.getByRole("dialog", { name: preview.previewPdfInitialsDialogTitle })

		await initials.getByRole("tab", { name: preview.previewPdfSignatureType }).click()
		await initials.getByLabel(preview.previewPdfInitialsTypeLabel).fill("JD")
		await initials.getByLabel(preview.previewPdfSignatureSaveForReuse).uncheck()
		await initials.getByRole("button", { name: preview.previewPdfSignaturePlace }).click()
		await pageSurface.click({ position: { x: 120, y: 470 } })

		await page.keyboard.press(`${mod}+s`)
		// The editor's Save: disabled while the save runs, so only "disabled and not busy" says it ended.
		await expectPdfSaved(page.getByRole("button", { name: preview.previewPdfSave, exact: true }), LIVE_WRITE_TIMEOUT_MS)

		const infos = await annotationInfos(await downloaded(page))
		const types = infos.map(annotations => annotations.map(annotation => annotation.subtype))

		// Diagnostic: which placement is missing when an Ink annotation is (each one's box and subject).
		await testInfo.attach("saved-annotations", { body: JSON.stringify(infos, null, "\t"), contentType: "application/json" })
		expect(types[1]).toEqual(expect.arrayContaining(["FreeText", "Ink", "Stamp"]))
		// The check mark, the cross and the drawn signature.
		expect(types[1]?.filter(type => type === "Ink").length).toBe(3)
		await close(page)

		// The next document offers the saved signature first.
		await open(page, listbox, second)
		await fillSignTab(page).click()
		await page.getByRole("button", { name: preview.previewPdfFillSignature }).click()

		const again = page.getByRole("dialog", { name: preview.previewPdfSignatureDialogTitle })

		await expect(again.getByRole("button", { name: "Saved signature 1" })).toHaveAttribute("aria-pressed", "true")
		await page.keyboard.press("Escape")
		await expect(again).toHaveCount(0)
		await close(page)
	})

	// Settings › Office: the one saved signature is listed and deleted everywhere.
	await page.goto("/settings/office")
	await expect(page.getByText(settings.settingsOfficePdfSavingNote)).toBeVisible()
	await expect(page.getByText(settings.settingsOfficeSavedSignaturesCount_one.replace("{{count}}", "1"), { exact: true })).toBeVisible({
		timeout: LIVE_WRITE_TIMEOUT_MS
	})
	await clearSavedSignatures(page)

	expect(cspViolations).toEqual([])
})

test("the signature pad draws with touch on a phone viewport", async ({ page, browserName }) => {
	test.skip(browserName !== "webkit", "touch drawing is checked on mobile WebKit")

	// With none saved the dialog opens on the drawing pad.
	await clearSavedSignatures(page)
	await page.setViewportSize({ width: 390, height: 844 })

	await withScratchDirectory(page, "pdf-fill-sign-touch", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-touch.pdf`

		await uploadFiles(page, [{ name, mimeType: PDF_MIME, buffer: readFileSync(FIXTURE) }], listbox)
		await open(page, listbox, name)
		await fillSignTab(page).click()
		await page.getByRole("button", { name: preview.previewPdfFillSignature }).click()

		const pad = page.getByRole("img", { name: preview.previewPdfSignaturePad })
		const box = await pad.boundingBox()

		if (box === null) throw new Error("drawing area not laid out")

		// A one-finger stroke as pointer events of type "touch" (what the pad reads).
		await pad.dispatchEvent("pointerdown", {
			pointerId: 7,
			pointerType: "touch",
			isPrimary: true,
			clientX: box.x + 20,
			clientY: box.y + 40
		})

		for (let step = 1; step <= 10; step++) {
			await pad.dispatchEvent("pointermove", {
				pointerId: 7,
				pointerType: "touch",
				clientX: box.x + 20 + step * 20,
				clientY: box.y + 40 + (step % 2) * 30
			})
		}

		await pad.dispatchEvent("pointerup", { pointerId: 7, pointerType: "touch" })
		await expect(pad).toHaveAttribute("data-strokes", "1")
		// The signature dialog closes first (a drawn signature is not placed); the next Escape is the viewer's.
		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog", { name: preview.previewPdfSignatureDialogTitle })).toHaveCount(0)
		await close(page)
	})
})
