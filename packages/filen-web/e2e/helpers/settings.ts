import type { Page } from "@playwright/test"
import { expect } from "../fixtures"
import { dismissStartupReminders } from "./listing"

// Client-nav only (same constraint as contacts.spec.ts/notes.spec.ts): the injection hook re-seeds and
// navigates to "/" → /drive on every load, so a hard goto to any other authed route bounces back before
// it renders. The one path into /settings is goto("/drive") then a real in-app click through the
// account menu — the "Settings" entry lands on /settings/account (the index route's redirect target).
//
// Also satisfies THE RULE for authed specs (helpers/listing.ts): the blocking startup reminders are
// dismissed here, before any shell interaction, so a caller needs no dismissal of its own.
export async function gotoSettings(page: Page): Promise<void> {
	await page.goto("/drive")
	await dismissStartupReminders(page)
	await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

	await page.getByRole("button", { name: "Account", exact: true }).click()
	await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
	await page.waitForURL(/\/settings\/account$/)
	// The account menu unmounts ~200ms AFTER the navigation resolves, and only then does Base UI
	// restore focus from the clicked menuitem back to the trigger. A caller that presses a key the
	// instant this helper returns aims it at a menuitem inside a still-open menu, where no
	// document-level hotkey fires — so settle the teardown here rather than in every caller.
	await expect(page.getByRole("menu")).toHaveCount(0)
}
