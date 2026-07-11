import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { dismissStartupReminders } from "./helpers/listing"
import { FIREFOX_HANG_REASON } from "./helpers/firefox"

// Notes shell smoke: rail entry → /notes, the contextual sidebar renders, the two-view toggle switches,
// and a UI-created note lands in the list and navigates. Net-zero on the shared FREE account — the one
// created note is torn down through the programmatic e2e hook (this shell has no trash UI yet; that
// lands in the actions step).
//
// Client-nav only (same constraint as contacts.spec.ts): the injection hook re-seeds and navigates to
// "/" → /drive on every load, so a hard goto to any other authed route bounces back before it renders.
// The one path into /notes is goto("/drive") then a real in-app rail click.
//
// Chromium-only: NotesSidebar fires authenticated reads (listNotes, listNoteTags) on mount — the same
// cross-origin worker SDK path that hangs on Playwright-firefox (helpers/firefox.ts).
//
// Serial, not parallel (same rationale as drive-actions.spec.ts): the shared FREE account's note cap
// is a hard 10 (server-enforced `note_limit_reached`), and several tests in this file create a real
// note — running them concurrently across workers risks stacking enough live notes to trip that cap
// well before any of their own net-zero teardowns run.
test.describe.configure({ mode: "serial" })

async function gotoNotes(page: Page): Promise<void> {
	await page.goto("/drive")

	// The authed shell raises a blocking startup reminder modal that renders the rest of the app inert
	// until dismissed — it must go before the rail is in the role tree for the click below.
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	await page.getByRole("link", { name: "Notes", exact: true }).click()
	await page.waitForURL(/\/notes(\/|$)/)

	// The sidebar renders independently of which route currently occupies the main card — a visible row
	// proves the LIST query has data, but proves NOTHING about whether notes.index.tsx's own
	// redirect-to-first-note effect has actually fired yet. Landing on bare "/notes" races that effect
	// against whatever the caller does next (e.g. clicking "New note"): both resolve to a `/notes/<uuid>`
	// URL, and if the caller's own navigate() wins the race while the index route is STILL mounted, a
	// later query-cache write (the caller's own create!) can retrigger the index effect's dependency and
	// have it redirect AGAIN — always toward the sort-first note (pinned beats everything, sort.ts), which
	// can silently steal the route out from under a just-created note. Live-verified: this raced and
	// landed on an unrelated pinned note often enough to be a real, not theoretical, hazard.
	const sidebar = page.getByRole("complementary")
	const noNotesYet = sidebar.getByText("No notes yet", { exact: true })
	await expect(sidebar.getByRole("link").first().or(noNotesYet)).toBeVisible()

	// Only wait for the URL to leave bare "/notes" when the account actually has notes to redirect to —
	// an empty account correctly never redirects, and waiting for a URL change that will never come
	// would hang forever.
	if ((await noNotesYet.count()) === 0) {
		await page.waitForURL(url => url.pathname !== "/notes")
	}
}

test.describe("notes", () => {
	test("rail entry navigates to /notes and renders the contextual sidebar", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoNotes(page)

		await expect(page.getByRole("link", { name: "Notes", exact: true })).toHaveAttribute("aria-current", "page")
		await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible()
		await expect(page.getByRole("button", { name: "New note", exact: true })).toBeVisible()
	})

	test("the two-view toggle switches between notes and tags", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoNotes(page)

		const notesToggle = page.getByRole("button", { name: "Notes", exact: true })
		const tagsToggle = page.getByRole("button", { name: "Tags", exact: true })

		// Notes is the default view.
		await expect(notesToggle).toHaveAttribute("aria-pressed", "true")

		await tagsToggle.click()
		await expect(tagsToggle).toHaveAttribute("aria-pressed", "true")
		await expect(notesToggle).toHaveAttribute("aria-pressed", "false")

		// Toggle back so the persisted view mode is left at its default.
		await notesToggle.click()
		await expect(notesToggle).toHaveAttribute("aria-pressed", "true")
	})

	test("creating a note lands in the list and navigates to it", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		await gotoNotes(page)

		// gotoNotes may already land on an existing note's own /notes/<uuid> route (its own redirect-race
		// comment above) — a bare `/\/notes\/[^/]+$/` waitForURL would then trivially match that STALE
		// url without ever waiting for the real client-side navigate this click triggers, so the wait must
		// require the url to actually change away from its pre-click value too.
		const urlBeforeCreate = page.url()
		await page.getByRole("button", { name: "New note", exact: true }).click()

		// The new note is selected and rendered in the editor card — its titled header (a level-1 heading)
		// only appears when the $uuid route resolved the note from the list, so this doubles as proof the
		// created note landed in the cache the sidebar reads from. The SDK assigns a default title, so this
		// asserts the header exists rather than a specific string.
		await page.waitForURL(url => url.toString() !== urlBeforeCreate && /\/notes\/[^/]+$/.test(url.pathname))
		await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible()

		const uuid = new URL(page.url()).pathname.split("/").pop() ?? ""
		expect(uuid.length).toBeGreaterThan(0)

		// Net-zero teardown: permanently remove the created note through the programmatic hook.
		await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
	})

	// Bounded, self-healing menu interaction. Every await inside carries its own explicit timeout well
	// under the toPass envelope, so a silently-swallowed step (a menu closed from under the click by a
	// concurrent re-render — the header re-renders whenever a mutation's cache patch lands, and popups
	// anchored to a re-rendering tree can drop a click on the floor) RETRIES the whole open→click
	// sequence instead of wedging an actionability wait against the full test budget: that exact mode
	// once ran a 240s test to death with the menu still open in the failure screenshot. Idempotent by
	// construction: the menu-open step is skipped when a previous attempt already left the menu open,
	// and every target is re-resolved from the live tree per attempt (descendInto's proven pattern).
	// Known tradeoff, accepted: for flip-label actions (Pin→Unpin, Trash→Restore) a retry AFTER the
	// effect landed (click fired but the close-wait lapsed — a sub-second window) finds the item gone
	// and fails the envelope with a clear "menuitem not found" — a diagnosable error, never a hang.
	async function runMenuAction(page: Page, trigger: Locator, itemName: string, until: "menuClosed" | "dialogOpen"): Promise<void> {
		const menu = page.getByRole("menu")

		await expect(async () => {
			if ((await menu.count()) === 0) {
				await trigger.click({ timeout: 10_000 })
				await expect(menu).toBeVisible({ timeout: 10_000 })
			}

			await page.getByRole("menuitem", { name: itemName, exact: true }).click({ timeout: 10_000 })

			if (until === "menuClosed") {
				// A "direct" descriptor's click closes the popup asynchronously (Base UI's close
				// animation) — the next action's own open would silently no-op against a half-closed
				// menu, so closure is part of THIS step's completion condition.
				await expect(menu).toHaveCount(0, { timeout: 10_000 })
			} else {
				await expect(page.getByRole("dialog").or(page.getByRole("alertdialog"))).toBeVisible({ timeout: 10_000 })
			}
		}).toPass({ timeout: 90_000 })
	}

	// Full action leg (e1-actions): create → rename → pin → favorite → tag assign (+ tags-view
	// expansion + tag-menu delete) → trash → restore → delete permanently, all through the editor
	// header's own ⋯ menu (noteMenu.tsx — the same descriptor list the sidebar row's menu renders).
	// One serial test covering the whole surface rather than one test per action: every step depends
	// on the previous one's live state (a rename before a pin has something to assert on, trash before
	// restore has something to restore), so splitting would only duplicate the create+rename setup per
	// test for no isolation gain.
	test("action menu: rename, pin, favorite, tag assign, trash/restore, delete permanently", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		// Generous budget: this single test drives ~10 real, sequential SDK mutations against the shared
		// account — well beyond the suite's default 90s if any one of them lands behind the SDK's own
		// internal rate-limit backoff (CLAUDE.md: retry/backoff is the SDK's job, never re-implemented
		// here). Live-measured a full run landing right at 180s under real backoff. The per-step toPass
		// envelopes (runMenuAction) keep any single wedged interaction from consuming this budget whole.
		test.setTimeout(240_000)

		await gotoNotes(page)

		// Same stale-url hazard as the "creating a note" test above — gotoNotes can already be sitting on
		// an existing note's route, so the wait must require an actual url change, not just a broad regex
		// match a pre-existing route already satisfies.
		const urlBeforeCreate = page.url()
		await page.getByRole("button", { name: "New note", exact: true }).click()
		await page.waitForURL(url => url.toString() !== urlBeforeCreate && /\/notes\/[^/]+$/.test(url.pathname))

		const uuid = new URL(page.url()).pathname.split("/").pop() ?? ""
		expect(uuid.length).toBeGreaterThan(0)

		const main = page.getByRole("main")
		const sidebar = page.getByRole("complementary")
		const row = sidebar.locator(`a[href="/notes/${uuid}"]`)
		const menuTrigger = main.getByRole("button", { name: "More actions", exact: true })
		const menu = page.getByRole("menu")
		const tagName = `e2e-tag-${String(Date.now())}`

		try {
			// Rename — InputDialog (role="dialog"), the field pre-filled with the SDK's default title.
			const newTitle = `e2e action note ${String(Date.now())}`
			await runMenuAction(page, menuTrigger, "Rename", "dialogOpen")
			const renameDialog = page.getByRole("dialog")
			await renameDialog.getByLabel("Title", { exact: true }).fill(newTitle)
			await renameDialog.getByRole("button", { name: "Rename", exact: true }).click()
			await expect(renameDialog).toHaveCount(0)
			await expect(main.getByRole("heading", { level: 1, name: newTitle, exact: true })).toBeVisible()

			// Pin — direct action, no dialog; verified on the note's own sidebar row. The row's pin/
			// favorite marks are bare aria-labeled <svg> icons (no ARIA role), so a plain attribute
			// selector is used rather than getByLabel (which targets form-control label association).
			await runMenuAction(page, menuTrigger, "Pin", "menuClosed")
			await expect(row.locator('[aria-label="Pinned"]')).toBeVisible()

			// Favorite — direct action, no dialog.
			await runMenuAction(page, menuTrigger, "Favorite", "menuClosed")
			await expect(row.locator('[aria-label="Favorite"]')).toBeVisible()

			// Tags submenu: the inline "New tag" entry creates a tag AND assigns it to this note in one
			// round trip (old-web parity, useNoteDialogHost's own handleCreateTagSubmit). Same bounded
			// toPass shape as runMenuAction, with the submenu's hover step inside the retried body — the
			// registry's SubmenuTrigger (ui/dropdown-menu.tsx, verbatim) defaults to openOnHover with
			// ignoreMouse on its click handler, so a real mouse .click() is silently ignored and never
			// opens the submenu (a .click() here previously hung the whole test until its timeout).
			await expect(async () => {
				if ((await menu.count()) === 0) {
					await menuTrigger.click({ timeout: 10_000 })
					// .first(): once the submenu opens, BOTH menus carry role="menu" — a bare toBeVisible
					// would strict-mode fail on the second attempt through this body.
					await expect(menu.first()).toBeVisible({ timeout: 10_000 })
				}

				await page.getByRole("menuitem", { name: "Tags", exact: true }).hover({ timeout: 10_000 })
				const newTagItem = page.getByRole("menuitem", { name: "New tag", exact: true })
				await newTagItem.click({ timeout: 10_000 })
				await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 })
			}).toPass({ timeout: 90_000 })
			const tagDialog = page.getByRole("dialog")
			await tagDialog.getByLabel("Name", { exact: true }).fill(tagName)
			await tagDialog.getByRole("button", { name: "Create", exact: true }).click()
			await expect(tagDialog).toHaveCount(0)

			// Tags view: the new tag's collapsible group, expanded, shows this note nested inside it.
			// Search narrows to the tag's own (unique, timestamped) name first — the shared account may
			// carry other tags, and the search box's state is shared across both sidebar views.
			await page.getByRole("button", { name: "Tags", exact: true }).click()
			const search = page.getByRole("searchbox", { name: "Search notes" })
			await search.fill(tagName)
			await sidebar.getByRole("button", { name: `Expand ${tagName}`, exact: true }).click()
			// A fresh note has no content yet, so its preview snippet falls back to the title too
			// (noteRow.tsx) — the title text legitimately renders twice in the expanded row (title +
			// preview spans); .first() is enough proof the note is nested under the tag.
			await expect(sidebar.getByText(newTitle, { exact: true }).first()).toBeVisible()

			// Tag-row context menu (rename/favorite/delete — TagContextMenuContent): delete the created
			// tag through it. Dogfoods the tags-view row menu AND keeps the account's tag list net-zero
			// on the success path (the finally's sweep below only exists for failure paths). The row is
			// expanded at this point, so its accessible name is the Collapse variant.
			await expect(async () => {
				if ((await menu.count()) === 0) {
					await sidebar
						.getByRole("button", { name: `Collapse ${tagName}`, exact: true })
						.click({ button: "right", timeout: 10_000 })
					await expect(menu).toBeVisible({ timeout: 10_000 })
				}

				await page.getByRole("menuitem", { name: "Delete", exact: true }).click({ timeout: 10_000 })
				await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 10_000 })
			}).toPass({ timeout: 90_000 })
			const tagDeleteDialog = page.getByRole("alertdialog")
			await tagDeleteDialog.getByRole("button", { name: "Delete", exact: true }).click()
			await expect(tagDeleteDialog).toHaveCount(0)
			// The group row disappears with its tag; the note itself survives (deleteNoteTag only strips
			// the tag) — asserted implicitly by every step below still operating on it.
			await expect(sidebar.getByRole("button", { name: `Collapse ${tagName}`, exact: true })).toHaveCount(0)

			await search.fill("")
			await page.getByRole("button", { name: "Notes", exact: true }).click()

			// Trash (direct, reversible — no confirm) then restore from within the notes UI.
			await runMenuAction(page, menuTrigger, "Trash", "menuClosed")

			// Restore + the trashed-variant pin. The trash confirm-then-patch lands async after its menu
			// closed, and an OPEN menu re-renders its variant in place when it does — so wait for Restore
			// to appear (patch landed) rather than asserting on whatever variant happened to render
			// first, then pin the reduction (trashed = restore/deletePermanently ONLY, noteMenuActions)
			// on the live menu before clicking.
			await expect(async () => {
				if ((await menu.count()) === 0) {
					await menuTrigger.click({ timeout: 10_000 })
					await expect(menu).toBeVisible({ timeout: 10_000 })
				}

				await expect(page.getByRole("menuitem", { name: "Restore", exact: true })).toBeVisible({ timeout: 15_000 })
				await expect(page.getByRole("menuitem", { name: "Trash", exact: true })).toHaveCount(0, { timeout: 2_000 })
				await page.getByRole("menuitem", { name: "Restore", exact: true }).click({ timeout: 10_000 })
				await expect(menu).toHaveCount(0, { timeout: 10_000 })
			}).toPass({ timeout: 90_000 })

			// Re-trash so Delete permanently is reachable: it only renders on the trashed variant, and
			// deleteNote itself no-ops on a non-trashed note (the original tail clicked it straight after
			// restore — an item that never existed on the restored menu; an unbounded click wait on it is
			// what once ran this test to its whole budget). This runMenuAction succeeding is ALSO the
			// restore proof: "Trash" only renders on a non-trashed menu, so the click waits for exactly
			// the restore patch. The delete step's own retry then absorbs the re-trash patch lag the same
			// way (its item appears once the trashed variant lands).
			await runMenuAction(page, menuTrigger, "Trash", "menuClosed")
			await runMenuAction(page, menuTrigger, "Delete permanently", "dialogOpen")

			// Delete permanently (confirm) — the note IS the currently-routed one, so a successful
			// confirm navigates away from it (useNoteDialogHost's nav-race guard) before this test's own
			// net-zero teardown call below (a no-op by then, since the note is already gone).
			const deleteDialog = page.getByRole("alertdialog")
			await deleteDialog.getByRole("button", { name: "Delete permanently", exact: true }).click()
			await page.waitForURL(url => !url.pathname.includes(uuid))
		} finally {
			// Best-effort: when the test-budget timeout killed the page, evaluate throws against the
			// closed target — swallowing that keeps the REAL failure as the test's reported error, and
			// cleanup-setup's own notes/tags sweep self-heals whatever a dead page left behind on the
			// next suite run.
			try {
				await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
				await page.evaluate(prefix => window.__filenE2E.sweepTestTagsByNamePrefix(prefix), tagName)
			} catch {
				// Covered by cleanup-setup on the next run.
			}
		}
	})
})

// Read-only content renderers (e1-reader): each note is created with a distinctive title + content
// through the programmatic hook layer (no editor UI exists yet), located in the sidebar via search
// (title is a random-suffixed string, so an exact-text match is unambiguous even against whatever else
// lives in the shared account), then opened for a render assertion. Net-zero teardown per test.
async function createAndOpenTestNote(
	page: Page,
	noteType: "text" | "code" | "md" | "rich" | "checklist",
	content: string,
	titlePrefix: string
): Promise<string> {
	const title = `${titlePrefix} ${String(Date.now())}-${String(Math.floor(Math.random() * 100_000))}`

	// The hook only exists once the app has booted — goto + dismiss first (same boot as gotoNotes), THEN
	// create the note, THEN enter /notes so its own list query mounts fresh and picks the new note up in
	// its very first fetch (no stale-cache dance: nothing has fetched the list yet in this page load).
	await page.goto("/drive")
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	const note = await page.evaluate(args => window.__filenE2E.createTestNoteWithContent(args.noteType, args.content, args.title), {
		noteType,
		content,
		title
	})

	await page.getByRole("link", { name: "Notes", exact: true }).click()
	await page.waitForURL(/\/notes(\/|$)/)

	// The newly created note is the most recently edited, so /notes' own first-note redirect (notes.tsx)
	// may already have selected it before this search even runs — which puts the SAME title in both the
	// sidebar row (a Link) AND the now-open editor card's h1 header, tripping getByText's strict-match
	// mode. Scoped to the sidebar's own <aside> landmark, which only ever contains the row match.
	await page.getByRole("searchbox", { name: "Search notes" }).fill(title)
	await page.getByRole("complementary").getByText(title, { exact: true }).click()
	await page.waitForURL(new RegExp(`/notes/${note.uuid}$`))

	return note.uuid
}

// try/finally (not a trailing call) around every assertion below: the shared FREE account's note cap
// is a hard 10 (server-enforced), so a note leaked by a failed assertion is not just untidy but can
// starve every LATER run's own createNote calls — the finally still fires when an expect() throws.
// This file's top-level test.describe.configure({ mode: "serial" }) already keeps every note-creating
// test (this block's and the "notes" block's own) from stacking concurrently against that cap.
test.describe("notes: read-only content renderers", () => {
	test("text note renders its raw content", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const content = "Hello from a plain text e2e note."
		const uuid = await createAndOpenTestNote(page, "text", content, "e2e text")

		try {
			// Scoped to <main> (the editor card) — the sidebar row's own preview snippet can equal the
			// raw content for short text, which would otherwise trip a page-wide exact-text strict match.
			await expect(page.getByRole("main").getByText(content, { exact: true })).toBeVisible()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})

	test("code note renders its raw content", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const content = "const answer = 42;"
		const uuid = await createAndOpenTestNote(page, "code", content, "e2e code")

		try {
			await expect(page.getByRole("main").getByText(content, { exact: true })).toBeVisible()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})

	test("md note renders both the raw source split and the live preview", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const content = "# E2E Heading\n\nSome **bold** text."
		const uuid = await createAndOpenTestNote(page, "md", content, "e2e md")
		const main = page.getByRole("main")

		try {
			// Left pane: raw markdown source (CodeMirror, read-only).
			await expect(main.getByText("# E2E Heading", { exact: true })).toBeVisible()
			// Right pane: the rendered preview — the same heading text, as a real heading element.
			await expect(main.getByRole("heading", { level: 1, name: "E2E Heading" })).toBeVisible()
			await expect(main.locator("strong", { hasText: "bold" })).toBeVisible()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})

	test("rich note renders sanitized HTML and strips a script tag", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const content = "<p>Hello <strong>rich</strong> note</p><script>window.__e2eRichXss = true</script>"
		const uuid = await createAndOpenTestNote(page, "rich", content, "e2e rich")
		const main = page.getByRole("main")

		try {
			await expect(main.getByText("Hello", { exact: false })).toBeVisible()
			await expect(main.locator("strong", { hasText: "rich" })).toBeVisible()
			// The script tag must never have made it into the DOM (sanitized before dangerouslySetInnerHTML)
			// or executed (its side effect never set the window flag).
			expect(await page.locator("script", { hasText: "__e2eRichXss" }).count()).toBe(0)
			expect(await page.evaluate(() => (window as unknown as { __e2eRichXss?: boolean }).__e2eRichXss)).toBeUndefined()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})

	// A writable (non-trashed) checklist note opens in the editable checklist widget, not the read-only
	// reader — the seed is parsed into faithful rows (values + checked state). The read-only ChecklistReader
	// is now reached only by a trashed note (deriveEditorReadOnly), which this shared FREE account has no
	// UI-free path to open; the seed-faithfulness it used to prove is covered here on the editor surface.
	test("checklist note opens in the editor with faithful rows and checked state", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const content = '<ul data-checked="false"><li>Buy milk</li></ul><ul data-checked="true"><li>Already done</li></ul>'
		const uuid = await createAndOpenTestNote(page, "checklist", content, "e2e checklist")

		const main = page.getByRole("main")

		try {
			const rows = main.getByRole("textbox")
			await expect(rows).toHaveCount(2)
			await expect(rows.nth(0)).toHaveValue("Buy milk")
			await expect(rows.nth(1)).toHaveValue("Already done")

			const checkboxes = main.getByRole("checkbox")
			await expect(checkboxes).toHaveCount(2)
			await expect(checkboxes.nth(0)).not.toBeChecked()
			await expect(checkboxes.nth(1)).toBeChecked()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})
})

// Live CodeMirror editing wired to the fault-tolerant outbox (e2-editor-text). These two legs are the
// proof of the founder's mandate: an edit survives a window-kill mid-edit AND still reaches the server.
// Serial + net-zero like every note-creating test above.
async function createEmptyNoteAndOpen(
	page: Page,
	noteType: "text" | "md" | "rich" | "checklist",
	titlePrefix: string
): Promise<{ uuid: string; title: string }> {
	const title = `${titlePrefix} ${String(Date.now())}-${String(Math.floor(Math.random() * 100_000))}`

	await page.goto("/drive")
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	// Empty content — the editor is what writes the content in these cases, not the hook.
	const note = await page.evaluate(args => window.__filenE2E.createTestNoteWithContent(args.noteType, "", args.title), {
		noteType,
		title
	})

	await openNoteByTitle(page, title, note.uuid)

	return { uuid: note.uuid, title }
}

// Enter /notes from the rail and open the note whose title matches, scoped to the sidebar (the same
// title. The row is clicked by its href, not its text: an EMPTY note repeats its title in BOTH the
// row's title span AND its preview snippet (noteRow.tsx falls the preview back to the title), so a
// getByText match would be strict-mode ambiguous.
async function openNoteByTitle(page: Page, title: string, uuid: string): Promise<void> {
	await page.getByRole("link", { name: "Notes", exact: true }).click()
	await page.waitForURL(/\/notes(\/|$)/)
	await page.getByRole("searchbox", { name: "Search notes" }).fill(title)
	await page.getByRole("complementary").locator(`a[href="/notes/${uuid}"]`).click()
	await page.waitForURL(new RegExp(`/notes/${uuid}$`))
}

async function reloadToShell(page: Page): Promise<void> {
	await page.reload()
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
}

test.describe("notes: live editors", () => {
	test("text edit typed then reloaded before the debounce survives and reaches the server", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)
		test.setTimeout(120_000)

		const marker = `killpath-${String(Date.now())}-${String(Math.floor(Math.random() * 100_000))}`
		const { uuid, title } = await createEmptyNoteAndOpen(page, "text", "e2e killpath")
		const main = page.getByRole("main")

		try {
			// Type distinctive content straight into the live CodeMirror surface.
			const editor = main.locator(".cm-content")
			await expect(editor).toBeVisible()
			await editor.click()
			await page.keyboard.type(marker)

			// Prove the immediate-persist landed on OPFS BEFORE the reload — the survives-window-close
			// guarantee. This settles in tens of ms, far under the 3s debounce, so the reload below still
			// beats any server push the debounce would kick.
			await expect
				.poll(() => page.evaluate(id => window.__filenE2E.readPersistedInflightContent(id), uuid), { timeout: 10_000 })
				.toBe(marker)

			// The tab dies mid-edit. On boot the outbox replays from OPFS; the editor seeds inflight-first.
			await reloadToShell(page)
			await openNoteByTitle(page, title, uuid)

			// The typed content is back in the editor after a reload that happened before any debounce push.
			await expect(main.getByText(marker, { exact: true })).toBeVisible()

			// ...and it reaches the server: replay-on-boot kicks a push even without a fresh debounce.
			await expect
				.poll(() => page.evaluate(id => window.__filenE2E.readTestNoteContentByUuid(id), uuid), { timeout: 30_000 })
				.toBe(marker)
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})

	test("md edit persists through the debounce and both panes reflect it after reload", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)
		test.setTimeout(120_000)

		const headingText = `ReloadHeading-${String(Date.now())}-${String(Math.floor(Math.random() * 100_000))}`
		const typed = `# ${headingText}`
		const { uuid, title } = await createEmptyNoteAndOpen(page, "md", "e2e md-edit")
		const main = page.getByRole("main")

		try {
			// Type a markdown heading into the editable LEFT pane.
			const editor = main.locator(".cm-content")
			await expect(editor).toBeVisible()
			await editor.click()
			await page.keyboard.type(typed)

			// Let the 3s debounce fire and the push land — the plain type→debounce→persist leg. Generous
			// timeout: the SDK owns its own retry/backoff, which can stretch a single push (CLAUDE.md).
			await expect
				.poll(() => page.evaluate(id => window.__filenE2E.readTestNoteContentByUuid(id), uuid), { timeout: 30_000 })
				.toBe(typed)

			// After reload the outbox has drained, so the note re-fetches its now-persisted server content
			// on mount (the content query's refetchOnMount:"always" overrides its persisted stale value).
			await reloadToShell(page)
			await openNoteByTitle(page, title, uuid)

			// Left pane: the raw markdown source (CodeMirror). Right pane: the rendered heading.
			await expect(main.getByText(typed, { exact: true })).toBeVisible()
			await expect(main.getByRole("heading", { level: 1, name: headingText })).toBeVisible()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})
})

// Rich (Quill) + custom checklist editors wired to the same fault-tolerant outbox (e2-editor-rich).
// Serial + net-zero like every note-creating test above.
test.describe("notes: rich and checklist editors", () => {
	test("rich toolbar formatting survives an immediate reload and reaches the server", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)
		test.setTimeout(120_000)

		const marker = `RichBold${String(Date.now())}${String(Math.floor(Math.random() * 100_000))}`
		const { uuid, title } = await createEmptyNoteAndOpen(page, "rich", "e2e rich-edit")
		const main = page.getByRole("main")

		try {
			// Type bold content straight into the live Quill surface: focus the editor, toggle Bold, type.
			const editor = main.locator(".ql-editor")
			await expect(editor).toBeVisible()
			await editor.click()
			await main.getByRole("button", { name: "Bold", exact: true }).click()
			await page.keyboard.type(marker)

			// The bold run is on screen before any reload — proves the toolbar drove quill.format.
			await expect(main.locator("strong", { hasText: marker })).toBeVisible()

			// The immediate-persist landed on OPFS (survives-window-close) well under the 3s debounce.
			await expect
				.poll(
					async () => {
						const persisted = await page.evaluate(id => window.__filenE2E.readPersistedInflightContent(id), uuid)

						return (persisted ?? "").includes(marker)
					},
					{ timeout: 10_000 }
				)
				.toBe(true)

			// The tab dies mid-edit; the outbox replays from OPFS on boot and the editor seeds inflight-first.
			await reloadToShell(page)
			await openNoteByTitle(page, title, uuid)

			// The formatting survived the reload — the bold run is back in the editor.
			await expect(main.locator(".ql-editor strong", { hasText: marker })).toBeVisible()

			// ...and it reaches the server as sanitized rich HTML (the <strong> wrapper preserved).
			await expect
				.poll(
					async () => {
						const content = (await page.evaluate(id => window.__filenE2E.readTestNoteContentByUuid(id), uuid)) ?? ""

						return content.includes(marker) && content.includes("<strong>")
					},
					{ timeout: 30_000 }
				)
				.toBe(true)
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})

	test("a hostile-HTML rich note opens sanitized in the editor and never executes its script", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const content = "<p>Safe <strong>rich</strong> body</p><script>window.__e2eEditorXss = true</script>"
		const uuid = await createAndOpenTestNote(page, "rich", content, "e2e rich-xss")
		const main = page.getByRole("main")

		try {
			// The note is writable, so it opens in the EDITOR (not the reader) — its seed is sanitized
			// before Quill ever sees it, so the safe structure renders and the script neither entered the
			// DOM nor ran.
			await expect(main.locator(".ql-editor")).toBeVisible()
			await expect(main.locator(".ql-editor strong", { hasText: "rich" })).toBeVisible()
			expect(await page.locator("script", { hasText: "__e2eEditorXss" }).count()).toBe(0)
			expect(await page.evaluate(() => (window as unknown as { __e2eEditorXss?: boolean }).__e2eEditorXss)).toBeUndefined()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})

	test("checklist rows added and toggled survive an immediate reload", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)
		test.setTimeout(120_000)

		const first = `Chk1-${String(Date.now())}-${String(Math.floor(Math.random() * 100_000))}`
		const second = `Chk2-${String(Date.now())}-${String(Math.floor(Math.random() * 100_000))}`
		const { uuid, title } = await createEmptyNoteAndOpen(page, "checklist", "e2e checklist-edit")
		const main = page.getByRole("main")

		try {
			// A brand-new checklist opens as one empty editable row. Type the first item, append a second
			// with Enter, type it, then check the first row's toggle.
			const rows = main.getByRole("textbox")
			await expect(rows.first()).toBeVisible()
			await rows.first().fill(first)
			await rows.first().press("Enter")
			await expect(rows).toHaveCount(2)
			await rows.nth(1).fill(second)

			const toggles = main.getByRole("checkbox")
			await toggles.nth(0).click()
			await expect(toggles.nth(0)).toBeChecked()

			// The serialized checklist landed on OPFS before the debounce — both items present.
			await expect
				.poll(
					async () => {
						const persisted = (await page.evaluate(id => window.__filenE2E.readPersistedInflightContent(id), uuid)) ?? ""

						return persisted.includes(first) && persisted.includes(second)
					},
					{ timeout: 10_000 }
				)
				.toBe(true)

			// Kill the tab mid-edit; the outbox replays and the editor seeds inflight-first.
			await reloadToShell(page)
			await openNoteByTitle(page, title, uuid)

			// Both rows are back with faithful text and checked state (first checked, second not).
			const reloadedRows = main.getByRole("textbox")
			await expect(reloadedRows).toHaveCount(2)
			await expect(reloadedRows.nth(0)).toHaveValue(first)
			await expect(reloadedRows.nth(1)).toHaveValue(second)

			const reloadedToggles = main.getByRole("checkbox")
			await expect(reloadedToggles.nth(0)).toBeChecked()
			await expect(reloadedToggles.nth(1)).not.toBeChecked()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})
})
