import { test, expect } from "./fixtures"
import { enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
import { trackCspViolations } from "./helpers/csp"

// Document/text-format preview rendering: docx, plain text, syntax-highlighted code, and GFM markdown
// — every leg opens a real lazy-loaded viewer chunk against a fixture file inside a per-run scratch
// directory (mirrors downloads.spec.ts's own enterScratchDirectory/trashScratchDirectory convention)
// rather than at /drive's root — this suite runs fullyParallel (playwright.config.ts), and a
// root-level create/trash races drive.spec.ts's own root-listing assertions (see
// drive-actions.spec.ts's comment for the exact failure this once produced live).
const FIREFOX_HANG_REASON = "drive listing needs an authenticated listDir call, which hangs indefinitely on Playwright-firefox under COI"

// Sequential within this file (one worker), overriding the config's fullyParallel — the same
// live-account rationale as drive-actions.spec.ts's own serial mode, but "default" so one test's
// failure doesn't skip the rest. Every test here creates and trashes a root-level scratch directory;
// with this file's own tests racing each other across workers, a teardown's root-row click can retry
// forever against a listing whose rows keep detaching/remounting under the concurrent creates/trashes
// plus focus-driven refetches (reproduced live: a teardown click stayed "element is not stable /
// detached from the DOM" for its whole remaining budget). Cross-FILE churn from other specs remains an
// accepted residual, exactly as drive-actions.spec.ts documents.
test.describe.configure({ mode: "default" })

// A hand-built, minimal docx: a single paragraph plus only the parts a conformant reader strictly
// needs ([Content_Types].xml, package rels, the document part and its own rels) — no styles/theme/
// numbering parts, which docx-preview tolerates (OpenXmlPackage.get returns undefined for an absent
// part, every caller already guards on that). Structurally validated via JSZip before being
// embedded here; the full render path is only provable in a real browser (docx-preview's XML
// parsing uses the native DOMParser, unavailable in node), which this e2e leg is that proof of.
const DOCX_BYTES = Buffer.from(
	"UEsDBBQAAAAIABQ76VwXmADX6wAAALIBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU4DMQy98xWRr2gmAweEUKc9sByBQ/kAK/HMRM2mOC3t3+NpoQdUONpvs99itQ9e7aiwS7GHm7YDRdEk6+LYw8f6pbkHxRWjRZ8i9XAghtXyarE+ZGIl4sg9TLXmB63ZTBSQ25QpCjKkErDKWEad0WxwJH3bdXfapFgp1qbOHiBmTzTg1lf1vJf96ZJCnkE9nphzWA+Ys3cGq+B6F+2vmOY7ohXlkcOTy3wtBNCXI2bo74Qf4ZuUU5wl9Y6lvmIQmv5MxWqbzDaItP3f58KlaRicobN+dsslGWKW1oNvz0hAF88f6GPlyy9QSwMEFAAAAAgAFDvpXD+t/vqvAAAALAEAAAsAAABfcmVscy8ucmVsc43POw7CMAwA0J1TRN5pWgaEUEMXhNQVlQNEiZtWNB/F4dPbk4EBKgZG/57tunnaid0x0uidgKoogaFTXo/OCLh0p/UOGCXptJy8QwEzEjSHVX3GSaY8Q8MYiGXEkYAhpbDnnNSAVlLhA7pc6X20MuUwGh6kukqDfFOWWx4/DVigrNUCYqsrYN0c8B/c9/2o8OjVzaJLP3YsOrIso8Ek4OGj5vqdLjILPJ/Dv548vABQSwMEFAAAAAgAFDvpXKv1I8S3AAAA+QAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOsU7FMAxFd77Cyk5TGBCq2r4NMTLAB4TEfS9SYkeOH23/nrQDLEfXsnWux8uWE/yg1Mg0maeuN4DkOUS6Tubr8+3x1UBVR8ElJpzMjtVc5odxHQL7e0ZSaAaqwzqZm2oZrK3+htnVjgtS2y0s2Wkb5WpXllCEPdbaCnKyz33/YrOLZE7nN4f9DGVukAM6v2NKDItwBgcaaYdWvcESN70LdqM9jg7KyXIKKnr9ENuy/dPa/6fnX1BLAwQUAAAACAAUO+lcjA6F0H0AAACdAAAAHAAAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHNVzEEOwiAQheG9pyCzt6ALY0xpdz2A0QNM6AiNMBCGGL29LHX58ud94/xOUb2oypbZwmEwoIhdXjf2Fu63ZX8GJQ15xZiZLHxIYJ5245Uitv6RsBVRHWGxEForF63FBUooQy7EvTxyTdj6rF4XdE/0pI/GnHT9NaCj+k+dvlBLAQIUAxQAAAAIABQ76VwXmADX6wAAALIBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAFDvpXD+t/vqvAAAALAEAAAsAAAAAAAAAAAAAAIABHAEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAFDvpXKv1I8S3AAAA+QAAABEAAAAAAAAAAAAAAIAB9AEAAHdvcmQvZG9jdW1lbnQueG1sUEsBAhQDFAAAAAgAFDvpXIwOhdB9AAAAnQAAABwAAAAAAAAAAAAAAIAB2gIAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHNQSwUGAAAAAAQABAADAQAAkQMAAAAA",
	"base64"
)

// A tiny plain-text fixture — proves the whole-buffer -> decodeUtf8 -> read-only CodeMirror path with
// no language grammar involved.
const TEXT_BYTES = Buffer.from("Hello from a tiny text fixture.\nSecond line here.\n", "utf8")

// A tiny TypeScript fixture — same path as TEXT_BYTES, but resolves a language (codeMirrorLanguageFor)
// and lazy-loads @codemirror/lang-javascript, proving the per-extension highlighting actually engages.
const CODE_BYTES = Buffer.from("export function add(a: number, b: number): number {\n\treturn a + b\n}\n", "utf8")

// A tiny GFM markdown fixture — a heading (real <h1> once rendered), bold text, and one safe external
// link (proves the target="_blank"/rel="noreferrer" + urlTransform link-hygiene path renders correctly
// for a SAFE link; the reject case is covered at the unit level, markdownViewer.logic.test.ts, mirroring
// docxViewer.logic.test.ts's own precedent).
const MARKDOWN_BYTES = Buffer.from("# Hello Markdown\n\nThis is **bold** text and a [safe link](https://example.com/safe).\n", "utf8")

// The one live proof the docx-preview path actually works: real JSZip/DOMParser XML parsing (neither
// is provable in node — DOMParser doesn't exist there) and real DOM rendering into the overlay, in a
// real browser. Also the empirical check for the one CSP-adjacent finding worth calling out: the
// shipped chunk bundles jszip's own `setimmediate` dependency, which contains a `Function(""+e)`
// fallback for a string-callback form of setImmediate — dead code (jszip only ever calls it with a
// real function), but this run's own zero-CSP-violations assertion is the empirical proof that dead
// path is never actually reached, not just an assumption from reading the source.
test("docx preview renders document content and closes, no CSP console errors", async ({ page, injectedSession, browserName }) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-docx-${runId}`
	const nameDocx = `e2e-preview-docx-${runId}.docx`

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([
			{
				name: nameDocx,
				mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				buffer: DOCX_BYTES
			}
		])

		const row = listbox.getByRole("option", { name: nameDocx })
		await expect(row).toBeVisible({ timeout: 45_000 })

		// Opens the docx-preview lazy chunk for the first time this run.
		await row.dblclick()
		const text = page.getByText("Hello from a tiny docx fixture.")
		await expect(text).toBeVisible({ timeout: 60_000 })

		await page.keyboard.press("Escape")
		await expect(text).toHaveCount(0)

		expect(cspViolations).toEqual([])
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

// The one live proof the text path actually works: a real lazy CodeMirror chunk, real UTF-8 decode, in
// a real browser — unlike preview.logic.test.ts's pure decodeUtf8/codeMirrorLanguageFor unit coverage,
// none of that is provable without one.
test("text preview decodes and renders read-only content, no CSP console errors", async ({ page, injectedSession, browserName }) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-text-${runId}`
	const nameTxt = `e2e-preview-text-${runId}.txt`

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameTxt, mimeType: "text/plain", buffer: TEXT_BYTES }])

		const row = listbox.getByRole("option", { name: nameTxt })
		await expect(row).toBeVisible({ timeout: 45_000 })

		// Opens the CodeMirror lazy chunk for the first time this run.
		await row.dblclick()
		const line = page.getByRole("dialog").getByText("Hello from a tiny text fixture.")
		await expect(line).toBeVisible({ timeout: 30_000 })
		await expect(page.getByText("Second line here.")).toBeVisible()

		await page.keyboard.press("Escape")
		await expect(line).toHaveCount(0)

		expect(cspViolations).toEqual([])
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

// Proves language routing actually engages a real @codemirror/lang-javascript chunk (not just plain
// text): a highlighted line wraps its tokens in <span>s, a plain one (the text leg above) doesn't.
test("code preview renders with syntax highlighting, no CSP console errors", async ({ page, injectedSession, browserName }) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-code-${runId}`
	const nameCode = `e2e-preview-code-${runId}.ts`

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameCode, mimeType: "video/mp2t", buffer: CODE_BYTES }])

		const row = listbox.getByRole("option", { name: nameCode })
		await expect(row).toBeVisible({ timeout: 45_000 })

		// Opens the CodeMirror + @codemirror/lang-javascript lazy chunks for the first time this run.
		await row.dblclick()
		await expect(page.getByText("export function add")).toBeVisible({ timeout: 30_000 })
		await expect(page.locator(".cm-line span").first()).toBeVisible({ timeout: 15_000 })

		await page.keyboard.press("Escape")
		await expect(page.getByText("export function add")).toHaveCount(0)

		expect(cspViolations).toEqual([])
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

// Proves the react-markdown + remark-gfm rendered view (a real <h1>, a safe external link with
// target="_blank"/rel="noreferrer"), the view-source toggle (falls back to the same CodeMirror surface
// the text/code legs above prove), and toggling back — the whole read-only markdown surface end to end.
test("markdown preview renders GFM content and its view-source toggle round-trips, no CSP console errors", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-md-${runId}`
	const nameMd = `e2e-preview-md-${runId}.md`

	const cspViolations = trackCspViolations(page)

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameMd, mimeType: "text/markdown", buffer: MARKDOWN_BYTES }])

		const row = listbox.getByRole("option", { name: nameMd })
		await expect(row).toBeVisible({ timeout: 45_000 })

		// Opens the react-markdown + remark-gfm lazy chunk for the first time this run.
		await row.dblclick()
		const heading = page.getByRole("heading", { name: "Hello Markdown", level: 1 })
		await expect(heading).toBeVisible({ timeout: 30_000 })

		const link = page.getByRole("link", { name: "safe link" })
		await expect(link).toHaveAttribute("target", "_blank")
		await expect(link).toHaveAttribute("rel", "noreferrer")

		// View source — mounts the same CodeMirror surface the text/code legs use, this run's first use
		// of it since this file never opened via the text/code path.
		await page.getByRole("button", { name: "View source" }).click()
		await expect(page.getByText("# Hello Markdown")).toBeVisible({ timeout: 30_000 })
		await expect(heading).toHaveCount(0)

		// Back to rendered.
		await page.getByRole("button", { name: "View rendered" }).click()
		await expect(heading).toBeVisible({ timeout: 15_000 })

		await page.keyboard.press("Escape")
		await expect(heading).toHaveCount(0)

		expect(cspViolations).toEqual([])
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
