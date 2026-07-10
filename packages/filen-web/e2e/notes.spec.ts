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
async function gotoNotes(page: Page): Promise<void> {
	await page.goto("/drive")

	// The authed shell raises a blocking startup reminder modal that renders the rest of the app inert
	// until dismissed — it must go before the rail is in the role tree for the click below.
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	await page.getByRole("link", { name: "Notes", exact: true }).click()
	await page.waitForURL(/\/notes(\/|$)/)
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

		await page.getByRole("button", { name: "New note", exact: true }).click()

		// The new note is selected and rendered in the editor card — its titled header (a level-1 heading)
		// only appears when the $uuid route resolved the note from the list, so this doubles as proof the
		// created note landed in the cache the sidebar reads from. The SDK assigns a default title, so this
		// asserts the header exists rather than a specific string.
		await page.waitForURL(/\/notes\/[^/]+$/)
		await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible()

		const uuid = new URL(page.url()).pathname.split("/").pop() ?? ""
		expect(uuid.length).toBeGreaterThan(0)

		// Net-zero teardown: permanently remove the created note through the programmatic hook.
		await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
	})
})
