import type { Page } from "@playwright/test"
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

	// Full action leg (e1-actions): create → rename → pin → favorite → tag assign (+ tags-view
	// expansion) → trash → restore → delete permanently, all through the editor header's own ⋯ menu
	// (noteMenu.tsx — the same descriptor list the sidebar row's menu renders). One serial test covering
	// the whole surface rather than one test per action: every step depends on the previous one's live
	// state (a rename before a pin has something to assert on, trash before restore has something to
	// restore), so splitting would only duplicate the create+rename setup per test for no isolation gain.
	test("action menu: rename, pin, favorite, tag assign, trash/restore, delete permanently", async ({
		page,
		injectedSession,
		browserName
	}) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		// Generous budget: this single test drives ~9 real, sequential SDK mutations (create/rename/pin/
		// favorite/createTag/addTag/trash/restore/delete) against the shared account — well beyond the
		// suite's default 90s if any one of them lands behind the SDK's own internal rate-limit backoff
		// (CLAUDE.md: retry/backoff is the SDK's job, never re-implemented here). Live-measured a full
		// run landing right at 180s under real backoff, close enough to the old budget to risk the test
		// timeout firing mid-flight and skipping its own net-zero teardown (worse than a slow pass).
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
		// A "direct" descriptor's click closes the popup asynchronously (Base UI's own close animation)
		// — reopening the menu before that settles can silently no-op the next click, so every reopen
		// below waits for the menu to be visible right after opening, and gone right after a direct
		// click, before moving on.
		const menu = page.getByRole("menu")

		try {
			// Rename — InputDialog (role="dialog"), the field pre-filled with the SDK's default title.
			const newTitle = `e2e action note ${String(Date.now())}`
			await menuTrigger.click()
			await expect(menu).toBeVisible()
			await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
			const renameDialog = page.getByRole("dialog")
			await expect(renameDialog).toBeVisible()
			await renameDialog.getByLabel("Title", { exact: true }).fill(newTitle)
			await renameDialog.getByRole("button", { name: "Rename", exact: true }).click()
			await expect(renameDialog).toHaveCount(0)
			await expect(main.getByRole("heading", { level: 1, name: newTitle, exact: true })).toBeVisible()

			// Pin — direct action, no dialog; verified on the note's own sidebar row. The row's pin/
			// favorite marks are bare aria-labeled <svg> icons (no ARIA role), so a plain attribute
			// selector is used rather than getByLabel (which targets form-control label association).
			await menuTrigger.click()
			await expect(menu).toBeVisible()
			await page.getByRole("menuitem", { name: "Pin", exact: true }).click()
			await expect(menu).toHaveCount(0)
			await expect(row.locator('[aria-label="Pinned"]')).toBeVisible()

			// Favorite — direct action, no dialog.
			await menuTrigger.click()
			await expect(menu).toBeVisible()
			await page.getByRole("menuitem", { name: "Favorite", exact: true }).click()
			await expect(menu).toHaveCount(0)
			await expect(row.locator('[aria-label="Favorite"]')).toBeVisible()

			// Tags submenu: the inline "New tag" entry creates a tag AND assigns it to this note in one
			// round trip (old-web parity, useNoteDialogHost's own handleCreateTagSubmit).
			const tagName = `e2e-tag-${String(Date.now())}`
			await menuTrigger.click()
			await expect(menu).toBeVisible()
			// The registry's SubmenuTrigger (ui/dropdown-menu.tsx, verbatim) defaults to openOnHover with
			// ignoreMouse on its click handler — a real mouse .click() is silently ignored and never opens
			// the submenu, so this must hover and wait for the submenu's own content before interacting
			// with it (a .click() here previously hung the whole test until its timeout, never finding
			// "New tag" in a submenu that never opened).
			await page.getByRole("menuitem", { name: "Tags", exact: true }).hover()
			const newTagItem = page.getByRole("menuitem", { name: "New tag", exact: true })
			await expect(newTagItem).toBeVisible()
			await newTagItem.click()
			const tagDialog = page.getByRole("dialog")
			await expect(tagDialog).toBeVisible()
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
			await search.fill("")
			await page.getByRole("button", { name: "Notes", exact: true }).click()

			// Trash (direct, reversible — no confirm) then restore from within the notes UI.
			await menuTrigger.click()
			await expect(menu).toBeVisible()
			await page.getByRole("menuitem", { name: "Trash", exact: true }).click()
			await expect(menu).toHaveCount(0)

			await menuTrigger.click()
			await expect(menu).toBeVisible()
			const restoreItem = page.getByRole("menuitem", { name: "Restore", exact: true })
			await expect(restoreItem).toBeVisible()
			// Trashed reduces the menu to restore/deletePermanently only (noteMenuActions) — proven live.
			await expect(page.getByRole("menuitem", { name: "Trash", exact: true })).toHaveCount(0)
			await restoreItem.click()
			await expect(menu).toHaveCount(0)

			await menuTrigger.click()
			await expect(menu).toBeVisible()
			await expect(page.getByRole("menuitem", { name: "Trash", exact: true })).toBeVisible()

			// Delete permanently (confirm) — the note IS the currently-routed one, so a successful
			// confirm navigates away from it (useNoteDialogHost's nav-race guard) before this test's own
			// net-zero teardown call below (a no-op by then, since the note is already gone).
			await page.getByRole("menuitem", { name: "Delete permanently", exact: true }).click()
			const deleteDialog = page.getByRole("alertdialog")
			await expect(deleteDialog).toBeVisible()
			await deleteDialog.getByRole("button", { name: "Delete permanently", exact: true }).click()
			await page.waitForURL(url => !url.pathname.includes(uuid))
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
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

	test("checklist note renders disabled checkbox rows with faithful checked state", async ({ page, injectedSession, browserName }) => {
		test.skip(browserName !== "chromium", FIREFOX_HANG_REASON)
		expect(injectedSession.length).toBeGreaterThan(0)

		const content = '<ul data-checked="false"><li>Buy milk</li></ul><ul data-checked="true"><li>Already done</li></ul>'
		const uuid = await createAndOpenTestNote(page, "checklist", content, "e2e checklist")

		const main = page.getByRole("main")

		try {
			await expect(main.getByText("Buy milk", { exact: true })).toBeVisible()
			await expect(main.getByText("Already done", { exact: true })).toBeVisible()

			const checkboxes = main.getByRole("checkbox")
			await expect(checkboxes).toHaveCount(2)
			expect(await checkboxes.nth(0).isChecked()).toBe(false)
			expect(await checkboxes.nth(1).isChecked()).toBe(true)
			await expect(checkboxes.nth(0)).toBeDisabled()
			await expect(checkboxes.nth(1)).toBeDisabled()
		} finally {
			await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
		}
	})
})
