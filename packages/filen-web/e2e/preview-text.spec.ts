import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import {
	withScratchDirectory,
	bootTo,
	enterScratchDirectory,
	trashScratchDirectory,
	waitForListingSettled,
	LAZY_VIEWER_TIMEOUT_MS,
	LIVE_WRITE_TIMEOUT_MS,
	uploadFiles
} from "./helpers/listing"
import { openFixtureRows } from "./helpers/fixtures"
import { focusEditorSurface } from "./helpers/editor"
import { DOCX_BYTES, TEXT_BYTES } from "./helpers/fixtureBytes"
import { trackCspViolations } from "./helpers/csp"

// Document/text-format preview rendering: docx, plain text, syntax-highlighted code, and GFM markdown
// — every leg opens a real lazy-loaded viewer chunk against a real file.
//
// SPLIT PROVISIONING, on purpose. The two read-only legs (docx, code) read the shared read-only
// fixture tree (helpers/fixtures.ts) and write nothing. The other three still own a per-test scratch
// directory, and each for a reason the shared tree cannot serve: the markdown leg SAVES its file, and
// the two navigation-guard legs edit a plain .txt (the first beside exactly one .docx sibling), a file
// the tree does not hold.

// Serialised by the write lane's `workers: 1` today; the directive keeps that true if it is ever widened.
test.describe.configure({ mode: "default" })

// A tiny GFM markdown fixture — a heading (real <h1> once rendered), bold text, and one safe external
// link (proves the target="_blank"/rel="noreferrer" + urlTransform link-hygiene path renders correctly
// for a SAFE link; the reject case is covered at the unit level, markdownViewer.logic.test.ts, mirroring
// docxViewer.logic.test.ts's own precedent).
const MARKDOWN_BYTES = Buffer.from("# Hello Markdown\n\nThis is **bold** text and a [safe link](https://example.com/safe).\n", "utf8")

// Teardown budget for the unsaved-changes prompt the finally's own Escape raises. It is a local React
// commit, not a write, but it has to be WAITED for rather than snapshotted: the first test below ends
// dirty by design, so on a green run the finally's Escape and the prompt's mount are a genuine race.
// Generous rather than tight because the two sides are not symmetric — losing the race means Discard is
// never clicked and the teardown falls through to trashScratchDirectory's reload recovery, a four-minute
// path, while waiting longer costs nothing on a run where the prompt never opens at all.
const UNSAVED_PROMPT_TIMEOUT_MS = 15_000

// The exact history both navigation-guard legs below depend on: the scratch directory current, with
// /favorites one entry AHEAD of it. Back never navigates under a preview (it closes the overlay, see
// previewOverlay.tsx's closeOnBack), so the route-leaving pop the unsaved-edits blocker guards is a
// Forward — built with in-app clicks inside ONE document, so it is a real popstate the router's
// blocker sees.
//
// A separate step run AFTER the scratch directory exists, because it navigates out of it and back —
// and because enterScratchDirectory's own retry path can reload the page, which throws away whatever
// history was built before it.
async function seedLeaveRouteForward(page: Page): Promise<void> {
	const scratchUrl = page.url()
	const entriesBefore = await page.evaluate(() => history.length)

	await page.getByRole("complementary").getByRole("link", { name: "Favorites", exact: true }).click()
	await expect(page).toHaveURL(/\/favorites$/)
	await waitForListingSettled(page)

	await page.goBack()
	await expect(page).toHaveURL(scratchUrl)
	await waitForListingSettled(page)

	// EXACTLY one push: an entry too many would put a different route under the Forward, and the leg
	// then waits out its budget for a prompt that never opens, several steps away from the cause.
	const entriesAfter = await page.evaluate(() => history.length)
	expect(entriesAfter - entriesBefore).toBe(1)
}

// The one live proof the docx-preview path actually works: real JSZip/DOMParser XML parsing (neither
// is provable in node — DOMParser doesn't exist there) and real DOM rendering into the overlay, in a
// real browser. Also the empirical check for the one CSP-adjacent finding worth calling out: the
// shipped chunk bundles jszip's own `setimmediate` dependency, which contains a `Function(""+e)`
// fallback for a string-callback form of setImmediate — dead code (jszip only ever calls it with a
// real function), but this run's own zero-CSP-violations assertion is the empirical proof that dead
// path is never actually reached, not just an assumption from reading the source.
test("docx preview renders document content and closes, no CSP console errors", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-docx")

	// Opens the docx-preview lazy chunk for the first time this run.
	await row.dblclick()
	const text = page.getByText("Hello from a tiny docx fixture.")
	await expect(text).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })

	await page.keyboard.press("Escape")
	await expect(text).toHaveCount(0)

	expect(cspViolations).toEqual([])
})

// The one live proof the text path actually works: a real lazy CodeMirror chunk, real UTF-8 decode, in
// a real browser — unlike preview.logic.test.ts's pure decodeUtf8/codeMirrorLanguageFor unit coverage,
// none of that is provable without one. A `.txt` in the drive variant is EDITABLE (isEditable), which
// is what also makes this leg the right host for the unsaved-edits guards below: it drives the browser's
// Back and Forward, the vectors the guards are actually about (a sidebar click cannot be used — the
// overlay's backdrop and popup are both `fixed inset-0 z-50`, so the sidebar link is covered and outside
// the modal's interaction scope, and Playwright's actionability check would simply time out).
test("text preview renders, edits, and guards unsaved edits against navigation, no CSP console errors", async ({ page }) => {
	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-text-${runId}`
	const nameTxt = `e2e-preview-text-${runId}.txt`
	const nameDocx = `e2e-preview-text-${runId}.docx`

	const cspViolations = trackCspViolations(page)

	const dialog = page.getByRole("dialog")
	const unsavedPrompt = page.getByRole("alertdialog", { name: "Unsaved changes" })

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		// A leave-route Forward for the guard leg below — see the helper for why this cannot run before the
		// scratch directory exists.
		await seedLeaveRouteForward(page)

		const scratchUrl = page.url()

		await uploadFiles(
			page,
			[
				{ name: nameTxt, mimeType: "text/plain", buffer: TEXT_BYTES },
				// A sibling slot that mounts NO editor — what proves the discard actually resets the buffer.
				{
					name: nameDocx,
					mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					buffer: DOCX_BYTES
				}
			],
			listbox
		)

		const row = listbox.getByRole("option", { name: nameTxt })

		// Opens the CodeMirror lazy chunk for the first time this run.
		await row.dblclick()
		const line = dialog.getByText("Hello from a tiny text fixture.")
		await expect(line).toBeVisible({ timeout: 30_000 })
		await expect(page.getByText("Second line here.")).toBeVisible()

		const saveButton = dialog.getByRole("button", { name: "Save", exact: true })
		const prevButton = dialog.getByRole("button", { name: "Previous file", exact: true })
		const nextButton = dialog.getByRole("button", { name: "Next file", exact: true })

		// Whichever pager direction the docx sibling happens to sit in — with exactly two slots, exactly
		// one of the two buttons is enabled from either end. WHICH one only settles once the slot's own
		// render has committed, though, and a one-shot read taken a tick early routes the step to the
		// disabled button, whose click then merely expires. Both buttons are always RENDERED (one
		// disabled), so the decidable state is polled rather than asserted through a combined locator,
		// which would match two elements and violate strict mode.
		async function stepToSibling(): Promise<void> {
			await expect.poll(async () => (await nextButton.isEnabled()) || (await prevButton.isEnabled()), { timeout: 15_000 }).toBe(true)

			if (await nextButton.isEnabled()) {
				await nextButton.click()
			} else {
				await prevButton.click()
			}
		}

		async function dirtyTheBuffer(): Promise<void> {
			// Focus, never mere visibility: a click that lands while the editor pane is remounting types
			// into document.body, and every assertion below then hunts a prompt that correctly never opens.
			await focusEditorSurface(dialog.locator(".cm-content"))
			await page.keyboard.type("x")
			// ENABLED, not merely visible: Save is RENDERED only while `editable && dirty`, and disabled
			// only while `saving` (previewOverlay.tsx), so enabled proves both that the buffer took the edit
			// and that no save is in flight.
			await expect(saveButton).toBeEnabled()
		}

		await dirtyTheBuffer()

		// Discard on a pager step must land on the sibling CLEAN: without the reset the overlay stays
		// "dirty" over a slot that mounts no editor at all, leaving a Save-less overlay permanently dirty
		// — a phantom prompt, and with the navigation blocker a phantom route block too.
		await stepToSibling()
		await expect(unsavedPrompt).toBeVisible()
		await unsavedPrompt.getByRole("button", { name: "Discard", exact: true }).click()
		await expect(page.getByText("Hello from a tiny docx fixture.")).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
		await expect(saveButton).toHaveCount(0)

		await stepToSibling()
		await expect(line).toBeVisible({ timeout: 30_000 })
		await expect(unsavedPrompt).toHaveCount(0)

		await dirtyTheBuffer()

		// Back closes the preview through its close path, so a dirty buffer prompts. The pop is put back
		// whatever the answer, hence the retrying toHaveURL; Cancel keeps the overlay and its buffer.
		await page.goBack()
		await expect(unsavedPrompt).toBeVisible()
		await unsavedPrompt.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(page).toHaveURL(scratchUrl)
		await expect(line).toBeVisible()
		await expect(saveButton).toBeEnabled()

		// A Forward to a different routeId ⇒ blocked by the leave-route guard. While the prompt is open the
		// browser URL is ALREADY /favorites (the pop landed; only the router was held back) — it is the
		// blocker's own go(-1) that restores it once the navigation is reset.
		await page.goForward()
		await expect(unsavedPrompt).toBeVisible()
		await unsavedPrompt.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(page).toHaveURL(scratchUrl)
		await expect(line).toBeVisible()

		// The blocked-pop DISCARD leg lives in its own test below. The buffer intentionally ends DIRTY
		// here; the finally below already dismisses the prompt its own Escape raises.
		expect(cspViolations).toEqual([])
	} finally {
		// trashScratchDirectory opens with Escape + a sidebar "Cloud Drive" click, and BOTH are defeated by
		// a still-dirty buffer (Escape opens the prompt; the link is covered by the overlay or blocked by
		// the router). The happy path above ends clean, but a failure mid-leg would otherwise leak the
		// scratch directory.
		await page.keyboard.press("Escape").catch(() => undefined)

		// waitFor, not isVisible: isVisible answers from the DOM as it stands, while the prompt mounts a
		// tick after the press it responds to — losing that race leaves the prompt standing, Discard
		// unclicked, and the trash below on its reload recovery path.
		const prompted = await unsavedPrompt
			.waitFor({ state: "visible", timeout: UNSAVED_PROMPT_TIMEOUT_MS })
			.then(() => true)
			.catch(() => false)

		if (prompted) {
			await unsavedPrompt
				.getByRole("button", { name: "Discard", exact: true })
				.click()
				.catch(() => undefined)
		}

		await trashScratchDirectory(page, scratchName)
	}
})

// Proves language routing actually engages a real @codemirror/lang-javascript chunk (not just plain
// text): a highlighted line wraps its tokens in <span>s, a plain one (the text leg above) doesn't.
test("code preview renders with syntax highlighting, no CSP console errors", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await bootTo(page)

	const {
		rows: [row]
	} = await openFixtureRows(page, "preview-code")

	// Opens the CodeMirror + @codemirror/lang-javascript lazy chunks for the first time this run.
	await row.dblclick()
	await expect(page.getByText("export function add")).toBeVisible({ timeout: 30_000 })
	await expect(page.locator(".cm-line span").first()).toBeVisible({ timeout: 15_000 })

	await page.keyboard.press("Escape")
	await expect(page.getByText("export function add")).toHaveCount(0)

	expect(cspViolations).toEqual([])
})

// Proves the react-markdown + remark-gfm rendered view (a real <h1>, a safe external link with
// target="_blank"/rel="noreferrer"), the view-source toggle (falls back to the same CodeMirror surface
// the text/code legs above prove), and toggling back — the whole read-only markdown surface end to end.
test("markdown preview renders GFM content and its view-source toggle round-trips, no CSP console errors", async ({ page }) => {
	const cspViolations = trackCspViolations(page)

	await withScratchDirectory(page, "preview-md", async ({ listbox, runId }) => {
		const nameMd = `e2e-preview-md-${runId}.md`

		await uploadFiles(page, [{ name: nameMd, mimeType: "text/markdown", buffer: MARKDOWN_BYTES }], listbox)

		const row = listbox.getByRole("option", { name: nameMd })

		// Opens the react-markdown + remark-gfm lazy chunk for the first time this run.
		await row.dblclick()
		const heading = page.getByRole("heading", { name: "Hello Markdown", level: 1 })
		await expect(heading).toBeVisible({ timeout: 30_000 })

		const link = page.getByRole("link", { name: "safe link" })
		await expect(link).toHaveAttribute("target", "_blank")
		await expect(link).toHaveAttribute("rel", "noreferrer")

		// View source — mounts the same CodeMirror surface the text/code legs use, this run's first use
		// of it since this file never opened via the text/code path.
		const viewSource = page.getByRole("button", { name: "View source" })
		const viewRendered = page.getByRole("button", { name: "View rendered" })

		await viewSource.click()
		await expect(page.getByText("# Hello Markdown")).toBeVisible({ timeout: 30_000 })
		await expect(heading).toHaveCount(0)

		// Back to rendered.
		await viewRendered.click()
		await expect(heading).toBeVisible({ timeout: 15_000 })

		// Editing the source: the toggle LOCKS while the buffer is dirty (flipping back to rendered
		// unmounts the editor, which would discard the buffer and strand the dirty flag), and the header's
		// Save button appears. The whole toggle/unmount interplay is DOM-only, so this is its only proof.
		const dialog = page.getByRole("dialog")
		const saveButton = dialog.getByRole("button", { name: "Save", exact: true })

		await viewSource.click()
		await expect(page.getByText("# Hello Markdown")).toBeVisible({ timeout: 30_000 })
		// The FIRST line specifically (a center click on .cm-content could land on the blank second line),
		// so the typed character lands in the heading and the saved result is observable as one — which is
		// also why focusEditorSurface is not used here: it clicks the surface, not a chosen line. The
		// focus assertion is the half of it that still matters, since keystrokes on an unfocused editor
		// land on document.body and record nothing.
		await dialog.locator(".cm-line").first().click()
		await expect(dialog.locator(".cm-content")).toBeFocused()
		await page.keyboard.press("End")
		await page.keyboard.type("!")
		await expect(viewRendered).toBeDisabled()
		await expect(saveButton).toBeVisible()

		// A save rotates the file uuid, which re-keys the body and remounts the viewer in its default
		// rendered mode — "save, then see the rendered result" is the shipped behavior.
		await saveButton.click()
		await expect(page.getByRole("heading", { name: "Hello Markdown!", level: 1 })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		// The dirty reset: without it both the Save button and the locked toggle stay in their dirty state
		// forever, and Escape below would pop a phantom "Unsaved changes" prompt instead of closing. On the
		// write budget like the heading above, not the expect default — all three close on the same
		// uuid-rotation remount, so a slow save leaves them arriving together, well past 10s.
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(viewSource).toBeEnabled({ timeout: LIVE_WRITE_TIMEOUT_MS })

		await page.keyboard.press("Escape")
		await expect(page.getByRole("alertdialog", { name: "Unsaved changes" })).toHaveCount(0)
		await expect(heading).toHaveCount(0)

		expect(cspViolations).toEqual([])
	})
})

// The blocked pop's DISCARD half — the main test above only proves Cancel/restore. Unlike that leg,
// this one asserts the DESTINATION a proceed() lands on, which is exactly the entry
// seedLeaveRouteForward puts ahead of the scratch directory.
test("discarding after a cancelled forward on the same pop still proceeds to the destination", async ({ page }) => {
	const scratchName = `e2e-preview-text-${crypto.randomUUID()}`
	const nameTxt = `${scratchName}.txt`
	const unsavedPrompt = page.getByRole("alertdialog", { name: "Unsaved changes" })

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		await seedLeaveRouteForward(page)

		const scratchUrl = page.url()

		await uploadFiles(page, [{ name: nameTxt, mimeType: "text/plain", buffer: TEXT_BYTES }], listbox)
		const row = listbox.getByRole("option", { name: nameTxt })
		await row.dblclick()

		const dialog = page.getByRole("dialog")
		await expect(dialog.getByText("Hello from a tiny text fixture.")).toBeVisible({ timeout: 30_000 })
		await focusEditorSurface(dialog.locator(".cm-content"))
		await page.keyboard.type("x")
		// Save is rendered only while `editable && dirty` and disabled only while `saving`, so enabled
		// proves the buffer took the edit with no save in flight — see dirtyTheBuffer's note above.
		await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled()

		await page.goForward()
		await expect(unsavedPrompt).toBeVisible()
		await unsavedPrompt.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(page).toHaveURL(scratchUrl)

		await page.goForward()
		await expect(unsavedPrompt).toBeVisible()
		await unsavedPrompt.getByRole("button", { name: "Discard", exact: true }).click()
		await expect(page).toHaveURL(/\/favorites$/)
	} finally {
		await page.keyboard.press("Escape").catch(() => undefined)

		// waitFor, not isVisible: isVisible answers from the DOM as it stands, while the prompt mounts a
		// tick after the press it responds to — losing that race leaves the prompt standing, Discard
		// unclicked, and the trash below on its reload recovery path.
		const prompted = await unsavedPrompt
			.waitFor({ state: "visible", timeout: UNSAVED_PROMPT_TIMEOUT_MS })
			.then(() => true)
			.catch(() => false)

		if (prompted) {
			await unsavedPrompt
				.getByRole("button", { name: "Discard", exact: true })
				.click()
				.catch(() => undefined)
		}

		await trashScratchDirectory(page, scratchName)
	}
})
