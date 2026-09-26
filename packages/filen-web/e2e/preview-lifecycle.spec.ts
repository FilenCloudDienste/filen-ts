import { test, expect } from "./fixtures"
import {
	bootTo,
	clickSidebarLink,
	waitForListingSettled,
	enterScratchDirectory,
	trashScratchDirectory,
	selectAndTrashRow,
	BOOT_SETTLE_TIMEOUT_MS,
	LIVE_WRITE_TIMEOUT_MS
} from "./helpers/listing"
import { focusEditorSurface } from "./helpers/editor"
import { TEXT_BYTES } from "./helpers/fixtureBytes"
import { resolveEditorModKey } from "./helpers/modkey"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Preview overlay lifecycle: editable-text save/persist/dirty-guard (including cross-sibling paging),
// and a trashed file's read-only preview variant. The edited/trashed files never leave their own
// per-run scratch directory (mirrors downloads.spec.ts's own enterScratchDirectory/
// trashScratchDirectory convention) rather than at /drive's root — this suite runs fullyParallel
// (playwright.config.ts), and a root-level create/trash races drive.spec.ts's own root-listing
// assertions (see drive-actions.spec.ts's comment for the exact failure this once produced live).

// Serialised by the write lane's `workers: 1` today; the directive keeps that true if it is ever widened.
test.describe.configure({ mode: "default" })

// Many short lines rather than a few long ones — small on the wire (a few KB), but at CodeMirror's
// default line height, taller in total than any reasonable preview viewport, so the scroll leg below
// exercises a genuine overflow instead of a container that merely COULD scroll.
const LONG_TEXT_LINE_COUNT = 400
const LONG_TEXT_BYTES = Buffer.from(
	`${Array.from({ length: LONG_TEXT_LINE_COUNT }, (_, i) => `line ${i.toString().padStart(4, "0")}`).join("\n")}\n`,
	"utf8"
)

// The one live proof the editable path actually works end to end: a real writable CodeMirror surface,
// a real worker uploadFileBytes round trip (uuid rotation included), and the dirty-guard confirm —
// unlike previewSave.logic.test.ts's injected-deps unit coverage, none of that is provable without a
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
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-edit-${runId}`
	const nameTxt = `e2e-preview-edit-${runId}.txt`
	const modKey = await resolveEditorModKey(page)
	// EVERY alertdialog in this file is scoped by its title, never by role alone (the convention
	// downloads.spec.ts and preview-text.spec.ts already follow): the shared account's own startup
	// reminders are alertdialogs too and can pop asynchronously mid-test, which makes a bare
	// getByRole("alertdialog") both a strict-mode hazard and — for the negative assertion below — a
	// false failure.
	const unsavedPrompt = page.getByRole("alertdialog", { name: "Unsaved changes" })

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.getByRole("main").locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameTxt, mimeType: "text/plain", buffer: TEXT_BYTES }])

		const row = listbox.getByRole("option", { name: nameTxt })
		await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		await row.dblclick()
		const original = page.getByRole("dialog").getByText("Hello from a tiny text fixture.")
		await expect(original).toBeVisible({ timeout: 30_000 })

		// Select-all + type replaces the whole buffer with a deterministic string (basicSetup's
		// defaultKeymap, on by default, binds Mod-a — verified against the installed
		// @uiw/codemirror-extensions-basic-setup) — simpler to assert on than an appended tail, and
		// exercises onChange/dirty-tracking across the WHOLE buffer, not just its end.
		const editor = page.locator(".cm-content")
		await focusEditorSurface(editor)
		await page.keyboard.press(`${modKey}+a`)
		await page.keyboard.type("edited content one")

		// ENABLED, not merely visible: Save is RENDERED only while `editable && dirty` and disabled only
		// while `saving` (previewOverlay.tsx), so enabled proves both that the buffer took the edit and
		// that no save is in flight.
		const saveButton = page.getByRole("button", { name: "Save", exact: true })
		await expect(saveButton).toBeEnabled()
		await saveButton.click()
		// The save clears the dirty bit once it resolves — the Save button (shown only while
		// editable+dirty) disappearing is the save's own success signal, no separate toast to wait on.
		// It closes on a real uploadFileBytes, so it gets the write budget rather than a UI one.
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

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
		await focusEditorSurface(editorAgain)
		await page.keyboard.press(`${modKey}+a`)
		await page.keyboard.type("edited content two")
		await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled()

		// Arrow keys move the CodeMirror caret while focus is inside the editor — they must never bubble
		// to the overlay's own pager key handler, which used to page (or, dirty as here, pop this very
		// unsaved-changes prompt) on every single press instead of leaving cursor movement to CodeMirror.
		// The caret's own offset carries the positive half of that: "no prompt appeared" holds just as
		// well when nothing handled the press at all, so the presses have to be observably CONSUMED.
		const caretOffset = () => page.evaluate(() => window.getSelection()?.focusOffset ?? -1)
		const caretAtEnd = await caretOffset()
		expect(caretAtEnd).toBeGreaterThan(0)

		await page.keyboard.press("ArrowLeft")
		await expect.poll(caretOffset).toBe(caretAtEnd - 1)
		await page.keyboard.press("ArrowRight")
		await expect.poll(caretOffset).toBe(caretAtEnd)

		await expect(unsavedPrompt).toHaveCount(0)
		await expect(page.getByText("edited content two")).toBeVisible()

		await page.keyboard.press("Escape")
		await expect(unsavedPrompt).toBeVisible()

		await unsavedPrompt.getByRole("button", { name: "Discard" }).click()
		await expect(unsavedPrompt).toHaveCount(0)
		await expect(page.locator(".cm-content")).toHaveCount(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

// Regression test: the CodeMirror wrapper div had no height class of its own, so it
// collapsed to its content's height instead of the bounded preview area — content past the fold was
// simply unreachable, wheel and keyboard scroll alike (textViewer.tsx's own className comment has the
// full mechanism). Asserts the FIX, not just the symptom's absence: the scroller's own box is taller
// than its visible area (a container that never overflowed would trivially "not be stuck" too), and a
// keyboard-driven scroll actually moves it.
test("editable text preview: a long file's editor actually scrolls", async ({ page, injectedSession, browserName }) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-scroll-${runId}`
	const nameTxt = `e2e-preview-scroll-${runId}.txt`
	const modKey = await resolveEditorModKey(page)

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.getByRole("main").locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameTxt, mimeType: "text/plain", buffer: LONG_TEXT_BYTES }])

		const row = listbox.getByRole("option", { name: nameTxt })
		await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		// A short viewport (not enterScratchDirectory's tall one, which exists only to defeat the drive
		// LISTING's own virtualization) — mirrors preview-media-formats.spec.ts's PDF leg. The fixture's
		// 400 lines can't all fit at once here, so what follows exercises a genuine overflow.
		await page.setViewportSize({ width: 1280, height: 800 })

		await row.dblclick()
		await expect(page.getByRole("dialog").getByText("line 0000")).toBeVisible({ timeout: 30_000 })

		const scroller = page.locator(".cm-scroller")
		const { scrollHeight, clientHeight } = await scroller.evaluate(el => ({
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight
		}))
		expect(scrollHeight).toBeGreaterThan(clientHeight)

		// Mod-End is CodeMirror's own defaultKeymap binding (cursorDocEnd, @codemirror/commands) — moves
		// the caret to the document's last character and scrolls it into view, the same outcome a real
		// user's manual wheel scroll to the bottom would produce.
		const editor = page.locator(".cm-content")
		await focusEditorSurface(editor)
		const scrollTopBefore = await scroller.evaluate(el => el.scrollTop)
		await page.keyboard.press(`${modKey}+End`)

		const lastLine = `line ${(LONG_TEXT_LINE_COUNT - 1).toString().padStart(4, "0")}`
		await expect(page.getByRole("dialog").getByText(lastLine)).toBeVisible({ timeout: 15_000 })
		await expect.poll(async () => scroller.evaluate(el => el.scrollTop), { timeout: 15_000 }).toBeGreaterThan(scrollTopBefore)

		await page.keyboard.press("Escape")
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
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-edit-pager-${runId}`
	const nameA = `e2e-preview-edit-pager-a-${runId}.txt`
	const nameB = `e2e-preview-edit-pager-b-${runId}.txt`
	const modKey = await resolveEditorModKey(page)

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.getByRole("main").locator('input[type="file"]').first()
		await input.setInputFiles([
			{ name: nameA, mimeType: "text/plain", buffer: TEXT_BYTES },
			{ name: nameB, mimeType: "text/plain", buffer: TEXT_BYTES }
		])

		const rowA = listbox.getByRole("option", { name: nameA })
		const rowB = listbox.getByRole("option", { name: nameB })
		await expect(rowA).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(rowB).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		// "a" sorts before "b" — Next from A lands on B, mirroring the image leg's own nameA/nameB proof.
		await rowA.dblclick()
		await expect(page.getByRole("dialog").getByText("Hello from a tiny text fixture.")).toBeVisible({ timeout: 30_000 })

		const editor = page.locator(".cm-content")
		// ENABLED before each click, never merely visible: Save renders only while `editable && dirty`
		// and is disabled while `saving`, so enabled proves the buffer took the edit with no save in
		// flight.
		const saveButton = page.getByRole("button", { name: "Save", exact: true })

		// First save: rotates A's uuid once. The button's disappearance closes on a real uploadFileBytes,
		// hence the write budget on both saves below.
		await focusEditorSurface(editor)
		await page.keyboard.press(`${modKey}+a`)
		await page.keyboard.type("A first save")
		await expect(saveButton).toBeEnabled()
		await saveButton.click()
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		// Second save, same slot, no navigation in between: rotates A's uuid again.
		await focusEditorSurface(editor)
		await page.keyboard.press(`${modKey}+a`)
		await page.keyboard.type("A second save")
		await expect(saveButton).toBeEnabled()
		await saveButton.click()
		await expect(saveButton).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

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
// isEditable(item, "trash") is false (previewSave.logic.test.ts) and the header hides Download in
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
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-trash-${runId}`
	const nameTxt = `e2e-preview-trash-${runId}.txt`

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.getByRole("main").locator('input[type="file"]').first()
		await input.setInputFiles([{ name: nameTxt, mimeType: "text/plain", buffer: TEXT_BYTES }])

		const row = listbox.getByRole("option", { name: nameTxt })
		await expect(row).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		// The helper rather than a hand-rolled select/confirm: it clears any lingering toast before the
		// bulk-bar click (Sonner and the bar share the bottom-right corner, and a fading toast swallows
		// exactly that click right after an upload), and it waits the confirm out on the write budget.
		await selectAndTrashRow(page, listbox, nameTxt)

		// An in-app sidebar-link click keeps this a client-side route change on the same booted app
		// instance — mirrors drive-actions.spec.ts's own identical rationale (a goto reload would race
		// listTrash() against the just-completed trash write).
		await clickSidebarLink(page, "Trash", /\/trash$/)

		const trashListing = await waitForListingSettled(page)

		// The URL commits before the trash listing does, so the trash-only Empty-trash trigger is required
		// first: the fill below must reach the trash listing's local filter, not the outgoing drive search.
		// It renders once the cold listTrash has landed, which a debris-laden trash makes slow.
		await expect(page.getByRole("button", { name: "Empty trash", exact: true })).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

		// The shared account's trash accumulates every net-zero run's scratch items, and directories sort
		// before files, so this just-trashed FILE mounts far below even a tall viewport's virtualization
		// window — the row simply doesn't exist in the DOM until it is reached. The listing's own filter
		// box is the way to reach it: every non-drive variant binds it to the instant local name filter
		// (directoryListing.tsx's localFilter), which is applied BEFORE sorting and virtualization, so
		// filling it collapses the listing to the matching row. It is component state keyed on the
		// listing, so it resets on navigation and nothing has to undo it.
		const filterBox = page.getByRole("searchbox", { name: "Search", exact: true })
		await filterBox.fill(nameTxt)

		const trashRow = trashListing.listbox.getByRole("option", { name: nameTxt })
		await expect(trashRow).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

		// Envelope the open, don't just fire it: the filtered listing still re-renders under the cursor
		// (the trash query refetches on focus), so the dblclick's two clicks can land on different rows
		// — the hazard descendInto documents for the same reason.
		const line = page.getByRole("dialog").getByText("Hello from a tiny text fixture.")

		await expect(async () => {
			if (!(await line.isVisible())) {
				await page.keyboard.press("Escape").catch(() => undefined)
				await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 })
				// Re-filtered per attempt, and that is the load-bearing part: the Escape above reaches the filter
				// box whenever focus is still in it (searchInput.tsx clears the query on Escape), and the
				// unfiltered listing virtualizes this row straight back out of the DOM.
				await filterBox.fill(nameTxt)
				await expect(trashRow).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
				await trashRow.dblclick()
			}

			await expect(line).toBeVisible({ timeout: 15_000 })
		}).toPass({ timeout: 90_000 })

		// Read-only: isEditable gates off outside the drive variant, so the Save button (rendered only
		// while editable, see previewOverlay.tsx) never appears — the trash listing's own item-level
		// menu still offers Restore/Delete-permanently (drive-actions.spec.ts covers that surface), just
		// not from inside this overlay.
		await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
		// The header's Download action is hidden in trash — mirrors the listing's own download gating.
		await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCount(0)

		await page.keyboard.press("Escape")
		await expect(line).toHaveCount(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})

// The preview header's own item menu (d6-preview-menu): same descriptor set the row/tile ⋯ dropdown
// offers (itemMenu.tsx), Download stripped since the header already has its own dedicated button right
// beside the trigger. Favorite round-trips silently (no dialog, no dirty state) via the menu's
// onFavoriteToggled hook into the overlay's own per-slot override map. Trash on a two-item preview
// proves the mirrored new-mobile behavior live: the pager steps to the remaining sibling in place
// rather than closing the whole overlay (useDriveDialogHost's removeCurrentPreviewItem) — unlike
// unshare, which new mobile (and this port) close outright instead (menuActions.ts's own
// dismissOnSuccess: isPreview === true), not exercisable here since the shared e2e account has no
// shared-root items to open a preview on (project_filen_web_free_e2e_account).
test("the preview header's own item menu: matches the row menu's set (no Download), favorite round-trips, trash advances to the next sibling", async ({
	page,
	injectedSession,
	browserName
}) => {
	test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
	expect(injectedSession.length).toBeGreaterThan(0)

	const runId = crypto.randomUUID()
	const scratchName = `e2e-preview-menu-${runId}`
	const nameA = `e2e-preview-menu-a-${runId}.txt`
	const nameB = `e2e-preview-menu-b-${runId}.txt`
	const contentA = Buffer.from("Preview menu content A\n", "utf8")
	const contentB = Buffer.from("Preview menu content B\n", "utf8")

	await bootTo(page)

	try {
		const { listbox } = await enterScratchDirectory(page, scratchName)

		const input = page.getByRole("main").locator('input[type="file"]').first()
		await input.setInputFiles([
			{ name: nameA, mimeType: "text/plain", buffer: contentA },
			{ name: nameB, mimeType: "text/plain", buffer: contentB }
		])

		const rowA = listbox.getByRole("option", { name: nameA })
		const rowB = listbox.getByRole("option", { name: nameB })
		await expect(rowA).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })
		await expect(rowB).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		// "a" sorts before "b" — opening A leaves B as its one sibling to advance onto after trash below.
		await rowA.dblclick()
		const dialog = page.getByRole("dialog")
		await expect(dialog.getByText("Preview menu content A")).toBeVisible({ timeout: 30_000 })

		const menuTrigger = dialog.getByRole("button", { name: "More actions", exact: true })
		const menu = page.getByRole("menu")

		// Reopened per attempt rather than asserted once: the header re-renders whenever a mutation's
		// cache patch lands, and a popup anchored to a re-rendering tree can be detached out from under
		// an assertion partway through the set (notes.spec.ts's runMenuAction carries the same shape).
		// The open step is skipped when a previous attempt already left the menu standing, so the common
		// path costs one open.
		await expect(async () => {
			if ((await menu.count()) === 0) {
				await menuTrigger.click({ timeout: 10_000 })
				await expect(menu).toBeVisible({ timeout: 10_000 })
			}

			// The row/tile ⋯ dropdown's own drive-variant set (itemMenu.test.ts), minus Download — the
			// header's separate Download button (still present, asserted below) covers that one.
			for (const label of ["Rename", "Move", "Favorite", "Info", "Share", "Public link", "Copy link", "Trash"]) {
				await expect(menu.getByRole("menuitem", { name: label, exact: true })).toBeVisible({ timeout: 10_000 })
			}

			await expect(menu.getByRole("menuitem", { name: "Download", exact: true })).toHaveCount(0)
		}).toPass({ timeout: 60_000 })

		await expect(dialog.getByRole("button", { name: "Download", exact: true })).toBeVisible()

		// An arrow key with this menu open must not page the preview under it: the menu renders for the
		// CURRENT slot, so a step swaps the item its Trash/Rename/Move act on out from beneath an already
		// open menu. FORWARD, not back: A sits at pager index 0 and stepPreviewSourceIndex clamps, so a
		// leaked ArrowLeft is a no-op there and "still on A" would hold with no guard at all — Next is
		// enabled at index 0, so only a leaked ArrowRight is observable, as B rendering in A's place.
		// Escape then closes just the menu, leaving the preview itself open on A.
		//
		// Guarded by handleKeyDown's isAnyMenuOpen() stand-down (previewOverlay.tsx), the same way
		// directoryListing.tsx guards its own keys. Nothing else stops it: Menu.Portal is a
		// ReactDOM.createPortal inside the dialog popup's React subtree, so the keydown reaches
		// handleKeyDown through the REACT tree wherever the popup sits in the DOM, and Base UI's
		// composite root stopPropagation()s only a key that actually moves the highlight — ArrowRight in
		// a vertical menu moves nothing. So a failure here is that guard regressing, which is the
		// trash-the-wrong-file bug: the menu still says A while acting on B.
		await page.keyboard.press("ArrowRight")
		await expect(dialog.getByText("Preview menu content A")).toBeVisible()
		await expect(dialog.getByText("Preview menu content B")).toHaveCount(0)
		await page.keyboard.press("Escape")
		await expect(menu).toHaveCount(0)
		await expect(dialog).toBeVisible()
		await expect(dialog.getByText("Preview menu content A")).toBeVisible()

		// Favorite: direct, no dialog. The menu closes on the click itself (the descriptor runs unawaited,
		// itemMenu.tsx), so the LABEL FLIP in a reopened menu is the only thing that says the setFavorited
		// write landed — at the write budget, since it queues on the account-wide drive lease.
		await menuTrigger.click()
		await expect(menu).toBeVisible()
		await menu.getByRole("menuitem", { name: "Favorite", exact: true }).click()
		await expect(menu).toHaveCount(0)
		await menuTrigger.click()
		await expect(menu.getByRole("menuitem", { name: "Unfavorite", exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		// Net-zero the favorite before trashing A, and settle it the same way: starting the trash while the
		// unfavorite is still in flight queues two writes on that one lease behind a single wait.
		await menu.getByRole("menuitem", { name: "Unfavorite", exact: true }).click()
		await expect(menu).toHaveCount(0)
		await menuTrigger.click()
		await expect(menu.getByRole("menuitem", { name: "Favorite", exact: true })).toBeVisible({ timeout: LIVE_WRITE_TIMEOUT_MS })

		// Trash A from inside the preview — the confirm nests over the overlay (Base UI dialog stacking).
		await menu.getByRole("menuitem", { name: "Trash", exact: true }).click()
		// Scoped by title, as everywhere else here — a startup reminder can pop as a second alertdialog.
		const trashConfirm = page.getByRole("alertdialog", { name: "Move to trash?" })
		await expect(trashConfirm).toBeVisible()
		await expect(trashConfirm.getByRole("heading", { name: "Move to trash?", exact: true })).toBeVisible()
		// handleMenuTrash awaits trashItems before clearing the dialog (previewOverlay.tsx), so unlike the
		// menu above, THIS close is the write settling — on the write budget for the same lease reason.
		await trashConfirm.getByRole("button", { name: "Trash", exact: true }).click()
		await expect(trashConfirm).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })

		// The pager steps onto B IN PLACE rather than closing the whole preview — the frozen two-item
		// snapshot now has one slot left, and A's removed index (0) clamps onto it.
		await expect(dialog).toBeVisible()
		await expect(dialog.getByText("Preview menu content B")).toBeVisible({ timeout: 30_000 })

		await page.keyboard.press("Escape")
		await expect(dialog).toHaveCount(0)
	} finally {
		await trashScratchDirectory(page, scratchName)
	}
})
