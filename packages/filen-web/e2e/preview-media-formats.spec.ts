import { test, expect } from "./fixtures"
import { enterFixtureDirectory, FIXTURE_FILES } from "./helpers/fixtures"
import { PDF_PASSWORD_CORRECT } from "./helpers/fixtureBytes"
import { trackCspViolations } from "./helpers/csp"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Format-specific preview rendering: image (the overlay's own pager loop), HEIC (client-side
// transform), and PDF (multi-page scroll, password retry) — every leg opens a real worker/decoder
// round trip against a file in the shared read-only fixture tree the fixtures-setup project builds
// once per run (helpers/fixtures.ts). Nothing here creates, uploads or trashes anything, which is why
// these tests no longer need serial mode within the file: the reason they had it was that each one
// created and trashed a directory at /drive's own root, and this file's tests racing each other over
// that made a teardown's root-row click retry forever against a listing whose rows kept detaching
// under the concurrent churn.

test("image preview opens, pages with the button and the arrow key, and closes with escape", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	// Exactly two slots, so the pager has somewhere to go and exactly one direction is enabled at each end.
	const [nameA, nameB] = FIXTURE_FILES["preview-image"]

	await page.goto("/drive")

	const { listbox } = await enterFixtureDirectory(page, "preview-image")

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
})

// The one live proof the HEIC path actually decodes: a real WASM library, lazy-loaded on first HEIC
// preview, running in a real browser — unlike the pure logic seams (preview.logic.test.ts,
// mediaType.test.ts, heicCodec.test.ts), an injected/mocked decoder can't prove this. Also
// proves the buffered-not-streamed guarantee end to end (the img's own src) and zero CSP violations
// during the WASM load + decode (the CSP concession this feature could have needed, but didn't).
test("HEIC preview transforms client-side and renders via the buffered path, never the SW route", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const [nameHeic] = FIXTURE_FILES["preview-heic"]

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	const { listbox } = await enterFixtureDirectory(page, "preview-heic")

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
})

// The one live proof the pdf.js path actually works: a real lazy chunk, a real dedicated worker
// (worker-src 'self'), real canvas rendering, in a real browser — unlike pdfViewer.logic.test.ts's
// pure page-visibility/canvas-sizing math, none of that is provable without one. Also proves the
// page-nav toolbar (button clicks, not the overlay's own file-level arrow keys) actually drives a
// real scroll and that the lazy render gate keeps up with it, and that the whole load produces zero
// CSP console violations (the pdf.js worker's own acceptance check). The selectable text layer and the
// annotation link overlay are DOM-only too — pdf.js generates that DOM, so this is their only proof.
test("PDF preview renders multi-page content with a selectable text layer and safe annotation links, pages via its own toolbar with a real scroll, and closes, no CSP console errors", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const [namePdf, nameLinksPdf] = FIXTURE_FILES["preview-pdf-pages"]

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	const { listbox } = await enterFixtureDirectory(page, "preview-pdf-pages")

	const row = listbox.getByRole("option", { name: namePdf })
	await expect(row).toBeVisible({ timeout: 45_000 })
	const linksRow = listbox.getByRole("option", { name: nameLinksPdf })
	await expect(linksRow).toBeVisible({ timeout: 45_000 })

	// A short viewport (rather than enterFixtureDirectory's tall one, which exists only to defeat
	// the drive LISTING's own virtualization) — PDF_BYTES' two 300x400pt pages can't both fit at
	// once here, so the Next-page assertion below exercises a genuine scroll.
	await page.setViewportSize({ width: 1280, height: 800 })

	// Opens the pdf.js lazy chunk for the first time this run (fetch + compile + a dedicated worker
	// spin-up), on top of the buffered download every whole-buffer preview already pays.
	await row.dblclick()
	const firstPageCanvas = page.locator('canvas[aria-label*="Page 1 of 2"]')
	await expect(firstPageCanvas).toBeVisible({ timeout: 60_000 })
	await expect(page.getByText("Page 1 of 2")).toBeVisible()

	// The selectable text layer: only present once TextLayer has actually rendered.
	const pageOneSpan = page.getByText("Page One")
	await expect(pageOneSpan).toBeVisible({ timeout: 30_000 })

	// STILL present after the canvas has finished (the spinner is gone / the canvas is no longer
	// `invisible`). Direct regression net for the effect-lifecycle trap: a text layer wiped by the
	// canvas render effect's own cleanup would pass a racy "appears" check and fail this one.
	await expect(firstPageCanvas).not.toHaveClass(/invisible/)
	await expect(pageOneSpan).toBeVisible()

	// The span must be laid out to the RIGHT SIZE, not merely present. A "non-zero bounding box"
	// check would be worthless: pdf.js positions spans with PERCENTAGE left/top, so a layer whose
	// font-size/transform are invalid at computed-value time (the missing --text-scale-factor /
	// --min-font-size-inv failure the copied stylesheet exists to prevent) still yields spans with
	// non-zero, in-canvas boxes. These ratios are derived from the fixture's own operators —
	// `BT /F1 24 Tf 20 200 Td (Page One) Tj ET` on a 300pt-wide MediaBox — and the standard Helvetica
	// advance widths: "Page One" is 667+556+556+556+278+778+556+556 = 4503/1000 em, x 24pt = 108.1pt,
	// / 300pt = 0.360; its left edge is 20/300 = 0.067. pdf.js pins the span to exactly that ratio via
	// --scale-x = canvasWidth * scale / measuredWidth, so both are scale- and zoom-independent, and a
	// broken layer (inherited ~14-16px font, no scaleX) lands far outside either band.
	const spanBox = await pageOneSpan.boundingBox()
	const canvasBox = await firstPageCanvas.boundingBox()

	if (!spanBox || !canvasBox) {
		throw new Error("text-layer span or page canvas has no bounding box")
	}

	expect(spanBox.x).toBeGreaterThanOrEqual(canvasBox.x - 1)
	expect(spanBox.y).toBeGreaterThanOrEqual(canvasBox.y - 1)
	expect(spanBox.x + spanBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1)
	expect(spanBox.y + spanBox.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height + 1)
	expect(spanBox.width / canvasBox.width).toBeGreaterThan(0.3)
	expect(spanBox.width / canvasBox.width).toBeLessThan(0.42)
	expect((spanBox.x - canvasBox.x) / canvasBox.width).toBeGreaterThan(0.047)
	expect((spanBox.x - canvasBox.x) / canvasBox.width).toBeLessThan(0.087)

	// A click on a text-layer span selects text; it must never toggle the overlay chrome away. Asserted
	// on the header's own opacity rather than on any control's visibility: hidden chrome stays in the DOM
	// with a full bounding box (`pointer-events-none opacity-0`, so focus can still restore it — see
	// previewOverlay.tsx), which makes a Playwright visibility check true in both states.
	const header = page.getByRole("dialog").locator("header")
	await expect(header).toHaveCSS("opacity", "1")
	await pageOneSpan.click()
	await expect(header).toHaveCSS("opacity", "1")

	// The page-nav "Next page" button (distinct from the overlay's own file-level "Next file")
	// scrolls page 2 into view; the indicator is IntersectionObserver-driven, so it follows once
	// the scroll settles rather than updating synchronously with the click.
	await page.getByRole("button", { name: "Next page" }).click()
	await expect(page.getByText("Page 2 of 2")).toBeVisible({ timeout: 15_000 })
	await expect(page.locator('canvas[aria-label*="Page 2 of 2"]')).toBeVisible({ timeout: 15_000 })

	await page.keyboard.press("Escape")
	await expect(firstPageCanvas).toHaveCount(0)

	// The link overlay: real positioned <a> elements built from getAnnotations() data. Only the
	// https: annotation renders — the javascript: one is dropped before it ever reaches the DOM
	// (unlike the docx sweep, which strips an href after render).
	await linksRow.dblclick()
	const linksPageCanvas = page.locator('canvas[aria-label*="Page 1 of 1"]')
	await expect(linksPageCanvas).toBeVisible({ timeout: 60_000 })

	const annotationLink = page.getByRole("dialog").getByRole("link")
	await expect(annotationLink).toHaveCount(1)
	await expect(annotationLink).toHaveAttribute("href", "https://example.com/pdf-link")
	await expect(annotationLink).toHaveAttribute("target", "_blank")
	await expect(annotationLink).toHaveAttribute("rel", "noreferrer")

	const linkBox = await annotationLink.boundingBox()
	const linksCanvasBox = await linksPageCanvas.boundingBox()

	if (!linkBox || !linksCanvasBox) {
		throw new Error("annotation link or page canvas has no bounding box")
	}

	expect(linkBox.x).toBeGreaterThanOrEqual(linksCanvasBox.x - 1)
	expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(linksCanvasBox.x + linksCanvasBox.width + 1)
	expect(linkBox.y).toBeGreaterThanOrEqual(linksCanvasBox.y - 1)
	expect(linkBox.y + linkBox.height).toBeLessThanOrEqual(linksCanvasBox.y + linksCanvasBox.height + 1)

	await page.keyboard.press("Escape")
	await expect(linksPageCanvas).toHaveCount(0)

	expect(cspViolations).toEqual([])
})

// Proves the password path live against a real AES-encrypted PDF (PDF_PASSWORD_BYTES): the initial
// prompt (onPassword fires with NEED_PASSWORD), a wrong-password retry (re-fires with
// INCORRECT_PASSWORD on the SAME loading task, never a second getDocument() call — see
// usePdfDocument's own comment on why a second call would hand pdf.js an already-detached buffer),
// and the correct password resolving to a real render. The shared InputDialog primitive is driven
// through its normal label/submit affordances, exactly as a user would.
test("PDF preview prompts for a password, retries after a wrong one, and renders once correct, no CSP console errors", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const [namePdf] = FIXTURE_FILES["preview-pdf-locked"]

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	const { listbox } = await enterFixtureDirectory(page, "preview-pdf-locked")

	const row = listbox.getByRole("option", { name: namePdf })
	await expect(row).toBeVisible({ timeout: 45_000 })

	// Opens the pdf.js lazy chunk for the first time this run; the loading task's onPassword fires
	// before its own promise ever settles, so the password prompt appears instead of a spinner.
	await row.dblclick()
	await expect(page.getByText("This PDF is password-protected. Enter the password to view it.")).toBeVisible({ timeout: 60_000 })

	// exact:true — a substring match on "Password" also matches the dialog's OWN accessible name
	// (aria-labelledby -> its title, "Password required"), a real Playwright ambiguity trap, not an
	// app bug: getByLabel("Password") alone resolves two elements (the dialog and the input) and a
	// .fill() then hangs waiting for that count to settle to one, which it never does.
	const passwordField = page.getByLabel("Password", { exact: true })

	await passwordField.fill("wrong-password")
	await page.getByRole("button", { name: "Unlock" }).click()
	await expect(page.getByText("That password was incorrect. Try again.")).toBeVisible({ timeout: 15_000 })

	await passwordField.fill(PDF_PASSWORD_CORRECT)
	await page.getByRole("button", { name: "Unlock" }).click()
	const canvas = page.locator('canvas[aria-label*="Page 1 of 2"]')
	await expect(canvas).toBeVisible({ timeout: 30_000 })

	await page.keyboard.press("Escape")
	await expect(canvas).toHaveCount(0)

	expect(cspViolations).toEqual([])
})
