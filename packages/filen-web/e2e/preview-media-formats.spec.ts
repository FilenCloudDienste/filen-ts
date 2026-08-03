import { test, expect } from "./fixtures"
import { enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Format-specific preview rendering: image (the overlay's own pager loop), HEIC (client-side
// transform), and PDF (multi-page scroll, password retry) — every leg opens a real worker/decoder
// round trip against a fixture file inside a per-run scratch directory (mirrors
// downloads.spec.ts's own enterScratchDirectory/trashScratchDirectory convention) rather than at
// /drive's root — this suite runs fullyParallel (playwright.config.ts), and a root-level create/trash
// races drive.spec.ts's own root-listing assertions (see drive-actions.spec.ts's comment for the exact
// failure this once produced live).

// Sequential within this file (one worker), overriding the config's fullyParallel — the same
// live-account rationale as drive-actions.spec.ts's own serial mode, but "default" so one test's
// failure doesn't skip the rest. Every test here creates and trashes a root-level scratch directory;
// with this file's own tests racing each other across workers, a teardown's root-row click can retry
// forever against a listing whose rows keep detaching/remounting under the concurrent creates/trashes
// plus focus-driven refetches (reproduced live: a teardown click stayed "element is not stable /
// detached from the DOM" for its whole remaining budget). Cross-FILE churn from other specs remains an
// accepted residual, exactly as drive-actions.spec.ts documents.
test.describe.configure({ mode: "default" })

// A real 1x1 transparent PNG.
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

// A real, tiny (505-byte) HEIC image — an 8x8 solid-red still picture, HEVC-encoded. Small enough to
// embed as base64 like the PNG fixture above, and genuinely decodable (verified against the exact
// libheif-js build this app lazy-loads before committing this fixture).
const HEIC_BYTES = Buffer.from(
	"AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAOZpcHJwAAAAxWlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAACAAAAAgAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMAAAMAHqAUIEHAmw7iHuRZVNwICBgCogABAAlEAcBhcshEU2QAAAAZaXBtYQAAAAAAAAABAAEGgQIDBYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAboAAAA/AAAAAW1kYXQAAAAAAAAATwAAADsoAa+i+kaBfP/92s//9uX7L9AKPVf/tCfI+buy/6ZQ90yyZ/og+cI53hzw5nPv9uVCL2FfgrcISbIrgA==",
	"base64"
)

// A hand-built, minimal 2-page PDF (PDF 1.4, no external resources — no cMap/font/wasm URL is
// configured so nothing this fixture needs ever leaves the page, exactly the production config).
// Generated from a small script and validated against the exact installed pdfjs-dist build
// (numPages, per-page text and viewport all confirmed) before being embedded here. Each page is
// 300x400pt — big enough that two of them can never both fit one screen at once, so the e2e leg
// below exercises a real scroll rather than relying on viewport happenstance.
const PDF_BYTES = Buffer.from(
	"JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgNDAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA3IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzOSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDIwIDIwMCBUZCAoUGFnZSBPbmUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDMwMCA0MDBdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDcgMCBSID4+ID4+IC9Db250ZW50cyA2IDAgUiA+PgplbmRvYmoKNiAwIG9iago8PCAvTGVuZ3RoIDM5ID4+CnN0cmVhbQpCVCAvRjEgMjQgVGYgMjAgMjAwIFRkIChQYWdlIFR3bykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzMzYgMDAwMDAgbiAKMDAwMDAwMDQ2MiAwMDAwMCBuIAowMDAwMDAwNTUxIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNjIxCiUlRU9G",
	"base64"
)

// A hand-built, single-page PDF carrying two /Link annotations with /URI actions: one `https:` and one
// `javascript:`. Same 300x400pt geometry as PDF_BYTES above. Validated against the exact installed
// pdfjs-dist build before being embedded here — getAnnotations({ intent: "display" }) reports both as
// Link, and pdf.js's own URL normalization already leaves the javascript: one with no `url` (only
// `unsafeUrl`), which this app's scheme allowlist is then the second, independent gate for.
const PDF_LINKS_BYTES = Buffer.from(
	"JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgNDAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgL0Fubm90cyBbNiAwIFIgNyAwIFJdID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggNDAgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiAyMCAyMDAgVGQgKExpbmsgUGFnZSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKNiAwIG9iago8PCAvVHlwZSAvQW5ub3QgL1N1YnR5cGUgL0xpbmsgL1JlY3QgWzIwIDE5MCAxNjAgMjIwXSAvQm9yZGVyIFswIDAgMF0gL0EgPDwgL1R5cGUgL0FjdGlvbiAvUyAvVVJJIC9VUkkgKGh0dHBzOi8vZXhhbXBsZS5jb20vcGRmLWxpbmspID4+ID4+CmVuZG9iago3IDAgb2JqCjw8IC9UeXBlIC9Bbm5vdCAvU3VidHlwZSAvTGluayAvUmVjdCBbMjAgMTAwIDE2MCAxMzBdIC9Cb3JkZXIgWzAgMCAwXSAvQSA8PCAvVHlwZSAvQWN0aW9uIC9TIC9VUkkgL1VSSSAoamF2YXNjcmlwdDphbGVydFwoMVwpKSA+PiA+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjYzIDAwMDAwIG4gCjAwMDAwMDAzNTMgMDAwMDAgbiAKMDAwMDAwMDQyMyAwMDAwMCBuIAowMDAwMDAwNTc4IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNzI2CiUlRU9G",
	"base64"
)

// The same 2-page PDF, password-protected — AES-128 (PDF standard security handler R4), generated
// once via pikepdf (a real, independent encryption implementation, not this app's own code) with
// user password "secret123". Validated against the exact installed pdfjs-dist build before being
// committed here: the un-passworded open triggers onPassword with NEED_PASSWORD, a wrong password
// re-triggers it with INCORRECT_PASSWORD, and the correct one resolves the SAME loading task to a
// working 2-page document — the exact sequence pdfViewer.tsx's usePdfDocument hook drives.
const PDF_PASSWORD_BYTES = Buffer.from(
	"JVBERi0xLjYKJb/3ov4KMSAwIG9iago8PCAvUGFnZXMgMiAwIFIgL1R5cGUgL0NhdGFsb2cgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL0NvdW50IDIgL0tpZHMgWyAzIDAgUiA0IDAgUiBdIC9UeXBlIC9QYWdlcyA+PgplbmRvYmoKMyAwIG9iago8PCAvQ29udGVudHMgNSAwIFIgL01lZGlhQm94IFsgMCAwIDMwMCA0MDAgXSAvUGFyZW50IDIgMCBSIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDYgMCBSID4+ID4+IC9UeXBlIC9QYWdlID4+CmVuZG9iago0IDAgb2JqCjw8IC9Db250ZW50cyA3IDAgUiAvTWVkaWFCb3ggWyAwIDAgMzAwIDQwMCBdIC9QYXJlbnQgMiAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNiAwIFIgPj4gPj4gL1R5cGUgL1BhZ2UgPj4KZW5kb2JqCjUgMCBvYmoKPDwgL0xlbmd0aCA2NCAvRmlsdGVyIC9GbGF0ZURlY29kZSA+PgpzdHJlYW0KajEZWRrynVE+b72EADOEJu/eeNMPj3NttaiHQyIqBI+EKBpRCB7VucqZ2zge4reHAKMWWJObqC6FLXprT5WpiQplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwgL0Jhc2VGb250IC9IZWx2ZXRpY2EgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250ID4+CmVuZG9iago3IDAgb2JqCjw8IC9MZW5ndGggNjQgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4Kc3RyZWFtCq72ksb31FLLdnejHE+E+lxTH6w8jcLeBAlCq02mt+j009z1GR1PVNR/swK/5lrvGjm9DjI17H6+rEwLHTSq8YgKZW5kc3RyZWFtCmVuZG9iago4IDAgb2JqCjw8IC9DRiA8PCAvU3RkQ0YgPDwgL0F1dGhFdmVudCAvRG9jT3BlbiAvQ0ZNIC9BRVNWMiAvTGVuZ3RoIDE2ID4+ID4+IC9GaWx0ZXIgL1N0YW5kYXJkIC9MZW5ndGggMTI4IC9PIDw1NjRlZTA5M2Q4MDhkMTM2Y2E1N2YxMzE3MGEyZTUzZjUwMjk0MTYxNGFlZjI3NWJjZjcyYjcxZjY0ZDc1ZGNkPiAvT0UgPD4gL1AgLTEwMjggL1IgNCAvU3RtRiAvU3RkQ0YgL1N0ckYgL1N0ZENGIC9VIDw5YjY2ODAxOWIzNjQzOTcwZDFkNTI1ZDViNjg5MTE3NzAwMjE0NDY5OTBiOWU0MTE0MDcxYTRkOTEwNDk4NGMxPiAvVUUgPD4gL1YgNCA+PgplbmRvYmoKeHJlZgowIDkKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyOSAwMDAwMCBuIAowMDAwMDAwMjU3IDAwMDAwIG4gCjAwMDAwMDAzODUgMDAwMDAgbiAKMDAwMDAwMDUyMCAwMDAwMCBuIAowMDAwMDAwNTkwIDAwMDAwIG4gCjAwMDAwMDA3MjUgMDAwMDAgbiAKdHJhaWxlciA8PCAvUm9vdCAxIDAgUiAvU2l6ZSA5IC9JRCBbPDgxYjI2YmE3ZTdmNzQ4N2MxMTBlMTQxNDFkYWJjNWUyPjw4MWIyNmJhN2U3Zjc0ODdjMTEwZTE0MTQxZGFiYzVlMj5dIC9FbmNyeXB0IDggMCBSID4+CnN0YXJ0eHJlZgoxMDQxCiUlRU9GCg==",
	"base64"
)
const PDF_PASSWORD_CORRECT = "secret123"

test("image preview opens, pages with the button and the arrow key, and closes with escape", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
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

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-heic-${runId}`
	const nameHeic = `e2e-preview-heic-${runId}.heic`

	const cspViolations = trackCspViolations(page)

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

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-pdf-${runId}`
	const namePdf = `e2e-preview-pdf-${runId}.pdf`
	const nameLinksPdf = `e2e-preview-pdf-links-${runId}.pdf`

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([
			{ name: namePdf, mimeType: "application/pdf", buffer: PDF_BYTES },
			{ name: nameLinksPdf, mimeType: "application/pdf", buffer: PDF_LINKS_BYTES }
		])

		const row = listbox.getByRole("option", { name: namePdf })
		await expect(row).toBeVisible({ timeout: 45_000 })
		const linksRow = listbox.getByRole("option", { name: nameLinksPdf })
		await expect(linksRow).toBeVisible({ timeout: 45_000 })

		// A short viewport (rather than enterScratchDirectory's tall one, which exists only to defeat
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

		// A click on a text-layer span selects text; it must never toggle the overlay chrome away.
		const closeButton = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true })
		await pageOneSpan.click()
		await expect(closeButton).toBeVisible()

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
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
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

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-pdf-pw-${runId}`
	const namePdf = `e2e-preview-pdf-pw-${runId}.pdf`

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([{ name: namePdf, mimeType: "application/pdf", buffer: PDF_PASSWORD_BYTES }])

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
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
