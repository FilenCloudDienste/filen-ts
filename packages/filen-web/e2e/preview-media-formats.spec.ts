import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { boxOf } from "./helpers/geometry"
import { PDF_PASSWORD_CORRECT } from "./helpers/fixtureBytes"
import { trackCspViolations } from "./helpers/csp"

// Format-specific preview rendering: image (the overlay's own pager loop), HEIC (client-side
// transform), and PDF (multi-page scroll, password retry) — every leg opens a real worker/decoder
// round trip against a file in the shared read-only fixture tree the fixtures-setup project builds
// once per run (helpers/fixtures.ts). Nothing here creates, uploads or trashes anything, which is why
// these tests no longer need serial mode within the file: the reason they had it was that each one
// created and trashed a directory at /drive's own root, and this file's tests racing each other over
// that made a teardown's root-row click retry forever against a listing whose rows kept detaching
// under the concurrent churn.

test("image preview opens, pages with the button and the arrow key, and closes with escape", async ({ page }) => {
	// Exactly two slots, so the pager has somewhere to go and exactly one direction is enabled at each end.
	const [nameA, nameB] = FIXTURE_FILES["preview-image"]

	await bootTo(page)

	const {
		rows: [rowA]
	} = await openFixtureRows(page, "preview-image")

	// Open the first image — the overlay renders it (worker round trip -> generous timeout).
	await rowA.dblclick()
	const imgA = page.getByRole("img", { name: nameA })
	await expect(imgA).toBeVisible({ timeout: 30_000 })

	// The on-screen next button pages forward (isolates the pager machinery from the key path). Both
	// pager buttons are always rendered, one of them disabled, so the button being ENABLED — not merely
	// present — is what says the overlay has committed the slot the image just rendered into; clicking a
	// still-disabled Next only expires against it.
	const next = page.getByRole("button", { name: "Next file" })
	await expect(next).toBeEnabled()
	await next.click()
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

// The one live proof of either HEIC path in a real browser: where the boot probe found a native decoder (Safari) the
// picture streams through the service worker's inline route like any image; elsewhere a real WASM library, lazy-loaded
// on first HEIC preview, decodes it into a blob. The branch follows the probe's answer read in the page, never the
// project name. Also zero CSP violations during either load (the CSP concession this feature could have needed, but
// didn't).
test("HEIC preview streams where the browser decodes HEIC itself, and is transformed client-side elsewhere", async ({ page }) => {
	const [nameHeic] = FIXTURE_FILES["preview-heic"]

	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const { heic: native } = await page.evaluate(() => window.__filenE2E.nativeImageSupport())

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-heic")

	// The WASM decoder is lazy-loaded here for the first time (fetch + compile + decode + a JPEG
	// re-encode), on top of the worker round trip every buffered preview already pays — a generous
	// timeout accounts for that, not just the download.
	await row.dblclick()
	const img = page.getByRole("img", { name: nameHeic })
	await expect(img).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect.poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(64)

	const src = await img.getAttribute("src")

	expect(src).toMatch(native ? /^\/sw\/download\// : /^blob:/)

	await page.keyboard.press("Escape")
	await expect(img).toHaveCount(0)

	expect(cspViolations).toEqual([])
})

// What each browser the suite runs decodes by itself, as the boot probe found it: recorded on the test, so a runner or
// browser update that changes it is visible. Chromium and Firefox have no HEIC decoder; HEIC in WebKit comes from
// Apple's platform decoders, so the Linux port is not expected to have one.
test("boot probe reports which image formats this browser decodes natively", async ({ page, browserName }) => {
	await bootTo(page)

	const support = await page.evaluate(() => window.__filenE2E.nativeImageSupport())

	test.info().annotations.push({
		type: "native-images",
		description: `${browserName}: heic ${String(support.heic)}, jxl ${String(support.jxl)}`
	})

	if (browserName !== "webkit") {
		expect(support.heic).toBe(false)
	}

	// Answered once per tab: asking again decodes nothing new and answers the same.
	expect(await page.evaluate(() => window.__filenE2E.nativeImageSupport())).toEqual(support)
})

// The one live proof the pdf.js path actually works: a real lazy chunk, a real dedicated worker
// (worker-src 'self'), real canvas rendering, in a real browser — unlike pdfViewer.logic.test.ts's
// pure page-visibility/canvas-sizing math, none of that is provable without one. Also proves the
// page-nav toolbar (button clicks, not the overlay's own file-level arrow keys) actually drives a
// real scroll and that the lazy render gate keeps up with it, and that the whole load produces zero
// CSP console violations (the pdf.js worker's own acceptance check). The selectable text layer and the
// annotation link overlay are DOM-only too — pdf.js generates that DOM, so this is their only proof.
test("PDF preview renders multi-page content with a selectable text layer and safe annotation links, pages via its own toolbar with a real scroll, finds text, and closes, no CSP console errors", async ({
	page
}) => {
	// Two 60s canvas renders, a 30s text layer, the retried band reads and the page-2 scroll add to
	// ~270s of pinned waits, on top of the fixture-tree descent preamble the read lane's 480s already
	// mostly holds — together they can exceed it. An explicit ceiling rather than test.slow(), which
	// triples that lane budget to 1440s for a test whose own worst case is ~560s (downloads.spec.ts opts
	// in the same way).
	test.setTimeout(600_000)

	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const {
		rows: [row, linksRow]
	} = await openFixtureRows(page, "preview-pdf-pages")

	// A short viewport (rather than enterFixtureDirectory's tall one, which exists only to defeat
	// the drive LISTING's own virtualization) — PDF_BYTES' two 300x400pt pages can't both fit at
	// once here, so the Next-page assertion below exercises a genuine scroll.
	await page.setViewportSize({ width: 1280, height: 800 })

	// Opens the pdf.js lazy chunk for the first time this run (fetch + compile + a dedicated worker
	// spin-up), on top of the buffered download every whole-buffer preview already pays.
	await row.dblclick()
	// Each page is a region named "<file> — Page n of N", sized to its canvas (which is decoration, aria-hidden).
	const firstPage = page.getByRole("region", { name: /Page 1 of 2$/u })
	await expect(firstPage).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByText("Page 1 of 2")).toBeVisible()

	// The selectable text layer: only present once TextLayer has actually rendered.
	const pageOneSpan = page.getByText("Page One")
	await expect(pageOneSpan).toBeVisible({ timeout: 30_000 })

	// STILL present after the canvas has finished (the page says data-rendered once its bitmap is painted at this
	// scale). Direct regression net for the effect-lifecycle trap: a text layer wiped by the
	// canvas render effect's own cleanup would pass a racy "appears" check and fail this one.
	await expect(firstPage).toHaveAttribute("data-rendered", "true", { timeout: 60_000 })
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
	//
	// Read inside a retry, not once: pdf.js sets each span's --scale-x from the canvas's measured width
	// AFTER the canvas paints, so a pair of boxes sampled in between is self-consistent and still outside
	// the band — a failure that says the layer is broken when it is only mid-layout.
	await expect(async () => {
		const spanBox = await boxOf(pageOneSpan)
		const canvasBox = await boxOf(firstPage)

		expect(spanBox.x).toBeGreaterThanOrEqual(canvasBox.x - 1)
		expect(spanBox.y).toBeGreaterThanOrEqual(canvasBox.y - 1)
		expect(spanBox.x + spanBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1)
		expect(spanBox.y + spanBox.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height + 1)
		expect(spanBox.width / canvasBox.width).toBeGreaterThan(0.3)
		expect(spanBox.width / canvasBox.width).toBeLessThan(0.42)
		expect((spanBox.x - canvasBox.x) / canvasBox.width).toBeGreaterThan(0.047)
		expect((spanBox.x - canvasBox.x) / canvasBox.width).toBeLessThan(0.087)
	}).toPass({ timeout: 30_000 })

	// The page-nav "Next page" button (distinct from the overlay's own file-level "Next file")
	// scrolls page 2 into view; the indicator is IntersectionObserver-driven, so it follows once
	// the scroll settles rather than updating synchronously with the click.
	await page.getByRole("button", { name: "Next page" }).click()
	await expect(page.getByText("Page 2 of 2")).toBeVisible({ timeout: 30_000 })
	const secondPage = page.getByRole("region", { name: /Page 2 of 2$/u })

	await expect(secondPage).toBeInViewport({ timeout: 30_000 })
	await expect(secondPage).toHaveAttribute("data-rendered", "true", { timeout: 30_000 })

	// Find: the toolbar's field searches every page's text and paints the matches into the text layer. It
	// starts at the page in view (page 2, the second match) and steps on round to page 1, scrolling it back
	// into view. Escape closes the field only, not the preview, and takes the highlights with it.
	await page.getByRole("button", { name: "Find in document" }).click()
	const findField = page.getByRole("searchbox", { name: "Find" })
	await findField.fill("page")
	await expect(page.getByText("2/2", { exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(page.locator(".fo-pdf-text-layer .highlight.selected")).toHaveText("Page", { timeout: 30_000 })
	await findField.press("Enter")
	await expect(page.getByText("1/2", { exact: true })).toBeVisible()
	await expect(page.locator(".fo-pdf-text-layer .highlight.selected")).toHaveText("Page")
	await findField.press("Escape")
	await expect(findField).toHaveCount(0)
	await expect(page.locator(".fo-pdf-text-layer .highlight")).toHaveCount(0)
	await expect(page.getByText("Page 1 of 2")).toBeVisible({ timeout: 30_000 })

	await page.keyboard.press("Escape")
	await expect(firstPage).toHaveCount(0)

	// The link overlay: real positioned <a> elements built from getAnnotations() data. Only the
	// https: annotation renders — the javascript: one is dropped before it ever reaches the DOM
	// (unlike the docx sweep, which strips an href after render).
	await linksRow.dblclick()
	const linksPage = page.getByRole("region", { name: /Page 1 of 1$/u })
	await expect(linksPage).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	const annotationLink = page.getByRole("dialog").getByRole("link")
	await expect(annotationLink).toHaveCount(1)
	await expect(annotationLink).toHaveAttribute("href", "https://example.com/pdf-link")
	await expect(annotationLink).toHaveAttribute("target", "_blank")
	await expect(annotationLink).toHaveAttribute("rel", "noreferrer")

	// Retried for the same reason the text-layer bands above are: the annotation layer is positioned off
	// the canvas's measured box, so a pair sampled mid-layout is self-consistent and still out of bounds.
	await expect(async () => {
		const linkBox = await boxOf(annotationLink)
		const linksCanvasBox = await boxOf(linksPage)

		expect(linkBox.x).toBeGreaterThanOrEqual(linksCanvasBox.x - 1)
		expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(linksCanvasBox.x + linksCanvasBox.width + 1)
		expect(linkBox.y).toBeGreaterThanOrEqual(linksCanvasBox.y - 1)
		expect(linkBox.y + linkBox.height).toBeLessThanOrEqual(linksCanvasBox.y + linksCanvasBox.height + 1)
	}).toPass({ timeout: 30_000 })

	await page.keyboard.press("Escape")
	await expect(linksPage).toHaveCount(0)

	expect(cspViolations).toEqual([])
})

// Proves the password path live against a real AES-encrypted PDF (PDF_PASSWORD_BYTES): the initial
// prompt (onPassword fires with NEED_PASSWORD), a wrong-password retry (re-fires with
// INCORRECT_PASSWORD on the SAME loading task, never a second getDocument() call — see
// usePdfDocument's own comment on why a second call would hand pdf.js an already-detached buffer),
// and the correct password resolving to a real render. The shared InputDialog primitive is driven
// through its normal label/submit affordances, exactly as a user would.
test("PDF preview prompts for a password, retries after a wrong one, and renders once correct, no CSP console errors", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-pdf-locked")

	// Opens the pdf.js lazy chunk for the first time this run; the loading task's onPassword fires
	// before its own promise ever settles, so the password prompt appears instead of a spinner.
	await row.dblclick()
	await expect(page.getByText("This PDF is password-protected. Enter the password to view it.")).toBeVisible({
		timeout: LAZY_VIEWER_TIMEOUT_MS
	})

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
	const firstPage = page.getByRole("region", { name: /Page 1 of 2$/u })
	await expect(firstPage).toBeVisible({ timeout: 30_000 })
	await expect(firstPage).toHaveAttribute("data-rendered", "true", { timeout: 30_000 })

	await page.keyboard.press("Escape")
	await expect(firstPage).toHaveCount(0)

	expect(cspViolations).toEqual([])
})
