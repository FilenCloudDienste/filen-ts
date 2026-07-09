import { test, expect } from "./fixtures"
import { waitForListingSettled, enterScratchDirectory, trashScratchDirectory } from "./helpers/listing"
import { resolveEditorModKey } from "./helpers/modkey"

// Preview overlay lifecycle: editable-text save/persist/dirty-guard (including cross-sibling paging),
// and a trashed file's read-only preview variant. The edited/trashed files never leave their own
// per-run scratch directory (mirrors downloads.spec.ts's own enterScratchDirectory/
// trashScratchDirectory convention) rather than at /drive's root — this suite runs fullyParallel
// (playwright.config.ts), and a root-level create/trash races drive.spec.ts's own root-listing
// assertions (see drive-actions.spec.ts's comment for the exact failure this once produced live).
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

// A tiny plain-text fixture — proves the whole-buffer -> decodeUtf8 -> read-only CodeMirror path with
// no language grammar involved.
const TEXT_BYTES = Buffer.from("Hello from a tiny text fixture.\nSecond line here.\n", "utf8")

// The one live proof the editable path actually works end to end: a real writable CodeMirror surface,
// a real worker uploadFileBytes round trip (uuid rotation included), and the dirty-guard confirm —
// unlike preview-save.logic.test.ts's injected-deps unit coverage, none of that is provable without a
// real worker. Net-zero via the same scratch-directory convention every other leg in this file uses
// (enterScratchDirectory/trashScratchDirectory) — the edited file never leaves the scratch directory,
// which the teardown trashes whole. Drives the Save button, not Cmd/Ctrl+S itself — mirrors
// downloads.spec.ts's own documented choice for this exact "mod+s" combo (a reserved browser shortcut;
// Chromium never delivers it to page JS under CDP-simulated keypresses, headless or not, live-verified
// while building this leg) — the keymap registration (preview.save, "mod+s", scope "editor") is a real
// user-facing shortcut in a real browser regardless, just not one Playwright can drive here.
test("editable text preview saves via its Save button, persists across reopen, and prompts on unsaved close", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-edit-${runId}`
	const nameTxt = `e2e-preview-edit-${runId}.txt`
	const modKey = await resolveEditorModKey(page)

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameTxt, mimeType: "text/plain", buffer: TEXT_BYTES }])

		const row = listbox.getByRole("option", { name: nameTxt })
		await expect(row).toBeVisible({ timeout: 45_000 })

		await row.dblclick()
		const original = page.getByRole("dialog").getByText("Hello from a tiny text fixture.")
		await expect(original).toBeVisible({ timeout: 30_000 })

		// Select-all + type replaces the whole buffer with a deterministic string (basicSetup's
		// defaultKeymap, on by default, binds Mod-a — verified against the installed
		// @uiw/codemirror-extensions-basic-setup) — simpler to assert on than an appended tail, and
		// exercises onChange/dirty-tracking across the WHOLE buffer, not just its end.
		const editor = page.locator(".cm-content")
		await editor.click()
		await page.keyboard.press(`${modKey}+a`)
		await page.keyboard.type("edited content one")

		const saveButton = page.getByRole("button", { name: "Save" })
		await expect(saveButton).toBeVisible()
		await saveButton.click()
		// The save clears the dirty bit once it resolves — the Save button (shown only while
		// editable+dirty) disappearing is the save's own success signal, no separate toast to wait on.
		await expect(saveButton).toHaveCount(0, { timeout: 15_000 })

		// Escape now closes cleanly (not dirty) — proves the confirm-on-close guard is dirty-gated, not
		// unconditional.
		await page.keyboard.press("Escape")
		await expect(page.locator(".cm-content")).toHaveCount(0)

		// Re-open: a fresh worker round trip against the ROTATED uuid (the row's own uuid changed, but
		// its NAME and listing position didn't — the same row is still reachable by name) — proves the
		// edit persisted server-side, not just an optimistic local echo.
		await expect(row).toBeVisible({ timeout: 15_000 })
		await row.dblclick()
		await expect(page.getByText("edited content one")).toBeVisible({ timeout: 30_000 })
		await expect(original).toHaveCount(0)

		// Dirty again, then Escape prompts a confirm instead of closing outright.
		const editorAgain = page.locator(".cm-content")
		await editorAgain.click()
		await page.keyboard.press(`${modKey}+a`)
		await page.keyboard.type("edited content two")
		await expect(page.getByRole("button", { name: "Save" })).toBeVisible()

		// Arrow keys move the CodeMirror caret while focus is inside the editor — they must never bubble
		// to the overlay's own pager key handler, which used to page (or, dirty as here, pop this very
		// unsaved-changes prompt) on every single press instead of leaving cursor movement to CodeMirror.
		await page.keyboard.press("ArrowLeft")
		await page.keyboard.press("ArrowRight")
		await expect(page.getByRole("alertdialog")).toHaveCount(0)
		await expect(page.getByText("edited content two")).toBeVisible()

		await page.keyboard.press("Escape")
		const confirmDialog = page.getByRole("alertdialog")
		await expect(confirmDialog).toBeVisible()
		await expect(confirmDialog).toContainText("Unsaved changes")

		await confirmDialog.getByRole("button", { name: "Discard" }).click()
		await expect(confirmDialog).toHaveCount(0)
		await expect(page.locator(".cm-content")).toHaveCount(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

// The exact multi-sibling regression a single accumulated-per-slot override (not a single shared slot)
// exists to fix: saving file A, paging to sibling B, then paging BACK to A must still resolve A's OWN
// just-saved content — a single-slot override would instead resolve the FROZEN pre-save uuid the
// pager's snapshot still carries for A's slot once a save on a DIFFERENT slot overwrote it, and the
// worker's own download op 404s on a uuid the earlier save already rotated away from. A is also saved
// TWICE in a row before ever paging away, proving a same-slot re-save chains onto the SAME accumulated
// entry (keyed by A's frozen uuid, not its already-rotated one) rather than orphaning the first save.
test("editable preview: saving a file, paging to a sibling and back still resolves its own saved content", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-edit-pager-${runId}`
	const nameA = `e2e-preview-edit-pager-a-${runId}.txt`
	const nameB = `e2e-preview-edit-pager-b-${runId}.txt`
	const modKey = await resolveEditorModKey(page)

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([
			{ name: nameA, mimeType: "text/plain", buffer: TEXT_BYTES },
			{ name: nameB, mimeType: "text/plain", buffer: TEXT_BYTES }
		])

		const rowA = listbox.getByRole("option", { name: nameA })
		const rowB = listbox.getByRole("option", { name: nameB })
		await expect(rowA).toBeVisible({ timeout: 45_000 })
		await expect(rowB).toBeVisible({ timeout: 45_000 })

		// "a" sorts before "b" — Next from A lands on B, mirroring the image leg's own nameA/nameB proof.
		await rowA.dblclick()
		await expect(page.getByRole("dialog").getByText("Hello from a tiny text fixture.")).toBeVisible({ timeout: 30_000 })

		const editor = page.locator(".cm-content")
		let saveButton = page.getByRole("button", { name: "Save" })

		// First save: rotates A's uuid once.
		await editor.click()
		await page.keyboard.press(`${modKey}+a`)
		await page.keyboard.type("A first save")
		await saveButton.click()
		await expect(saveButton).toHaveCount(0, { timeout: 15_000 })

		// Second save, same slot, no navigation in between: rotates A's uuid again.
		await editor.click()
		await page.keyboard.press(`${modKey}+a`)
		await page.keyboard.type("A second save")
		saveButton = page.getByRole("button", { name: "Save" })
		await expect(saveButton).toBeVisible()
		await saveButton.click()
		await expect(saveButton).toHaveCount(0, { timeout: 15_000 })

		// Page to sibling B (still its original, unedited content)...
		await page.getByRole("button", { name: "Next file" }).click()
		await expect(page.getByRole("dialog").getByText("Hello from a tiny text fixture.")).toBeVisible({ timeout: 30_000 })

		// ...then back to A: must render A's OWN latest saved content, never a download error.
		await page.getByRole("button", { name: "Previous file" }).click()
		await expect(page.getByText("A second save")).toBeVisible({ timeout: 30_000 })

		await page.keyboard.press("Escape")
		await expect(page.locator(".cm-content")).toHaveCount(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

// The one live proof the trash-preview parity rule actually wires together: canPreview(item, "trash")
// stays true (preview.logic.test.ts) rather than excluding trash like an undecryptable item, but
// isEditable(item, "trash") is false (preview-save.logic.test.ts) and the header hides Download in
// trash (previewOverlay.tsx's own variant check) — none of that is provable without a real trashed
// item reachable from a real Trash listing. Trashes the FILE itself (the single-item Trash flow
// drive-actions.spec.ts's own bulk test exercises for multiple items), not the scratch directory, so
// the item is a top-level Trash entry (a trashed directory's own contents stay unbrowsable — this
// proves the file case only). The now-empty scratch directory still gets trashed as usual in the
// teardown, same as every other test in this file.
test("a trashed file opens its preview read-only: content renders, no save action, no download action", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	test.setTimeout(120_000)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-trash-${runId}`
	const nameTxt = `e2e-preview-trash-${runId}.txt`

	await page.goto("/drive")

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameTxt, mimeType: "text/plain", buffer: TEXT_BYTES }])

		const row = listbox.getByRole("option", { name: nameTxt })
		await expect(row).toBeVisible({ timeout: 45_000 })

		await row.click()
		await page.getByRole("button", { name: "Trash", exact: true }).click()
		const trashConfirm = page.getByRole("alertdialog")
		await expect(trashConfirm).toBeVisible()
		await trashConfirm.getByRole("button", { name: "Trash", exact: true }).click()
		await expect(trashConfirm).toHaveCount(0)
		await expect(row).toHaveCount(0)

		// An in-app sidebar-link click keeps this a client-side route change on the same booted app
		// instance — mirrors drive-actions.spec.ts's own identical rationale (a goto reload would race
		// listTrash() against the just-completed trash write).
		await page.getByRole("complementary").getByRole("link", { name: "Trash", exact: true }).click()
		const trashListing = await waitForListingSettled(page)
		const trashRow = trashListing.listbox.getByRole("option", { name: nameTxt })

		// The shared account's trash accumulates every net-zero run's scratch items (312 at the time
		// this was written), and directories sort before files, so this just-trashed FILE mounts far
		// below even the tall viewport's virtualization window — the row simply doesn't exist in the
		// DOM until scrolled to (reproduced live). Wheel down in steps smaller than the window (no
		// overshoot past a mounted-but-not-yet-checked row), settling briefly so the virtualizer has
		// rendered before each probe; the real assertion still follows the loop, so a genuine absence
		// fails loudly rather than silently scrolling forever.
		await trashListing.listbox.hover()
		for (let i = 0; i < 30 && !(await trashRow.isVisible()); i++) {
			await page.mouse.wheel(0, 5000)
			await page.waitForTimeout(250)
		}
		await expect(trashRow).toBeVisible({ timeout: 15_000 })

		await trashRow.dblclick()
		const line = page.getByRole("dialog").getByText("Hello from a tiny text fixture.")
		await expect(line).toBeVisible({ timeout: 30_000 })

		// Read-only: isEditable gates off outside the drive variant, so the Save button (rendered only
		// while editable, see previewOverlay.tsx) never appears — the trash listing's own item-level
		// menu still offers Restore/Delete-permanently (drive-actions.spec.ts covers that surface), just
		// not from inside this overlay.
		await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0)
		// The header's Download action is hidden in trash — mirrors the listing's own download gating.
		await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCount(0)

		await page.keyboard.press("Escape")
		await expect(line).toHaveCount(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
