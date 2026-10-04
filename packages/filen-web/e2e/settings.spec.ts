import { readFileSync } from "node:fs"
import { test, expect } from "./fixtures"
import { trackConsoleErrors } from "./helpers/csp"
import { gotoSettings, openSettingsSection, waitForAccountLoaded } from "./helpers/settings"
import { BOOT_SETTLE_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"

// Every settings section here is either a plain, read-only render (Account/Appearance/Security's own
// existing assertions) or a client-side-only preference (theme) — nothing in this spec live-mutates
// session-invalidating or irreversible account state (changeEmail/setNickname/updatePersonalInfo/
// uploadAvatar/deleteAll* all stay unit/render-only, never invoked against the live shared account).
// getUserInfo/getGdprInfo are the only live network reads exercised, both read-only.
test.describe("settings", () => {
	test("the settings sidebar renders every section and Account is the index-redirect landing section", async ({ page }) => {
		await gotoSettings(page)

		for (const label of ["Account", "Security", "Appearance", "Keyboard", "Events", "Billing", "Advanced"]) {
			await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible()
		}

		await expect(page.getByRole("link", { name: "Account", exact: true })).toHaveAttribute("aria-current", "page")
	})

	test("the Account section renders live getUserInfo data (email + storage breakdown)", async ({ page }) => {
		await gotoSettings(page)
		await waitForAccountLoaded(page)

		// Each pattern scoped to the row or group that owns it, never the whole page: an unscoped email
		// regex matches any address the shell (or the profile header) happens to render, and an unscoped
		// quota regex any other "… of … used" copy — either would let this pass on something that is not
		// the live getUserInfo read. Group titles are case-insensitive: they render uppercased.
		const emailRow = page.locator('[data-slot="settings-row"]').filter({ hasText: "Email address" })
		const storageGroup = page.locator('[data-slot="settings-group"]').filter({ has: page.getByRole("heading", { name: /^storage$/i }) })

		await expect(emailRow.getByText(/[^\s@]+@[^\s@]+\.[^\s@]+/)).toBeVisible()
		await expect(emailRow.getByRole("button", { name: "Change email", exact: true })).toBeVisible()

		await expect(storageGroup.getByText(/of .* used/)).toBeVisible()
	})

	test("security page is reachable from the sidebar and renders its rows", async ({ page }) => {
		await gotoSettings(page)
		// The Security page gates on the same account read, so it renders from the settled cache.
		await waitForAccountLoaded(page)

		await openSettingsSection(page, "Security")

		await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible()
		// The row buttons read "Change…"/"Export…"; their accessible names carry the full action.
		await expect(page.getByText("Password", { exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Change password", exact: true })).toBeVisible()
		await expect(page.getByText("Two-factor authentication", { exact: true })).toBeVisible()
		await expect(page.getByText("Master keys", { exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Export master keys", exact: true })).toBeVisible()
		await expect(page.getByText("Delete account", { exact: true })).toBeVisible()
	})

	test("the Events section renders live getUserEvents rows (the e2e account has login history)", async ({ page }) => {
		await gotoSettings(page)

		await openSettingsSection(page, "Events")

		// The list renders exactly one of two terminal states, and the container below exists only in the
		// non-empty one (eventsList.tsx). Raced first, then narrowed: asserting the empty state's absence
		// up front is instantly true while the paginated read is still in flight, which left the row
		// assertion to close inside the 10s expect default on a live network round trip.
		const firstEventRow = page.locator('[aria-label="Events"]').getByRole("button").first()
		const emptyState = page.getByText("No events in the last 30 days", { exact: true })

		await expect(firstEventRow.or(emptyState)).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(emptyState).toHaveCount(0)
		await expect(firstEventRow).toBeVisible()
	})

	test("the Billing section renders every table's empty state (the e2e account is FREE)", async ({ page }) => {
		await gotoSettings(page)

		await openSettingsSection(page, "Billing")

		// Scoped to the plan row: "Free" also names the free storage elsewhere in settings.
		const currentPlan = page.locator('[data-slot="settings-group"]').filter({ hasText: "Current plan" })

		await expect(currentPlan.getByText("Free", { exact: true })).toBeVisible()
		await expect(page.getByText("No subscriptions", { exact: true })).toBeVisible()
		await expect(page.getByText("No invoices", { exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Copy link", exact: true })).toBeVisible()
	})

	test("the destructive data-control rows render but their typed-confirm gate blocks a wrong phrase (never live-mutated)", async ({
		page
	}) => {
		await gotoSettings(page)
		await waitForAccountLoaded(page)

		await expect(page.getByText("Delete all versioned files", { exact: true })).toBeVisible()
		await page.getByRole("button", { name: "Delete versioned files", exact: true }).click()

		// Scoped to the dialog carrying THIS row's own confirm button, never "an alertdialog": the
		// startup account reminders are alertdialogs too and mount asynchronously, so a bare role lookup
		// is a strict-mode hazard, aims the gate assertions at whatever dialog happens to be up, and
		// makes the toHaveCount(0) below fail on a dialog that did close.
		const versionsDialog = page
			.getByRole("alertdialog")
			.filter({ has: page.getByRole("button", { name: "Delete versioned files", exact: true }) })
		const versionsConfirm = versionsDialog.getByRole("button", { name: "Delete versioned files", exact: true })

		await expect(versionsConfirm).toBeDisabled()
		await versionsDialog.getByLabel("Confirmation phrase", { exact: true }).fill("delete versions") // near-miss: wrong case
		await expect(versionsConfirm).toBeDisabled()
		// Deliberately never filled with the exact phrase and clicked — that would call
		// deleteAllVersions() against the shared e2e account's real drive.
		await versionsDialog.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(versionsDialog).toHaveCount(0)

		await expect(page.getByText("Delete all files and directories", { exact: true })).toBeVisible()
		await page.getByRole("button", { name: "Delete everything", exact: true }).click()

		// Same scoping as the versions dialog above.
		const itemsDialog = page
			.getByRole("alertdialog")
			.filter({ has: page.getByRole("button", { name: "Delete everything", exact: true }) })
		const itemsConfirm = itemsDialog.getByRole("button", { name: "Delete everything", exact: true })

		await expect(itemsConfirm).toBeDisabled()
		await itemsDialog.getByLabel("Confirmation phrase", { exact: true }).fill("delete everything") // near-miss: wrong case
		await expect(itemsConfirm).toBeDisabled()
		await itemsDialog.getByRole("button", { name: "Cancel", exact: true }).click()
	})

	test("the theme three-way switch round-trips through light/dark/system", async ({ page }) => {
		await gotoSettings(page)
		await openSettingsSection(page, "Appearance")

		// Disambiguated (not a bare getByRole("combobox")): the Appearance page also has the Start
		// Screen select now.
		const trigger = page.getByRole("combobox", { name: "Theme" })

		async function pickTheme(label: string): Promise<void> {
			// One popup at a time. Base UI keeps a CLOSING Select popup mounted through its exit animation,
			// so opening the next pick while the previous is still unwinding puts two listboxes on the page
			// — a bare role lookup there is a strict-mode violation, not a useful failure. Waited out first,
			// and `.last()` as the backstop for the page's other select (Start Screen).
			await expect(page.getByRole("listbox")).toHaveCount(0)
			// Opened from the keyboard, not a click: Base UI opens the list with the selected item under the
			// pointer and, 400ms after opening, lets a mouse release commit it. On a slow runner a click's
			// release lands past that and re-selects the current theme, closing the list.
			await trigger.focus()
			await page.keyboard.press("Enter")

			const options = page.getByRole("listbox").last()

			await expect(options).toBeVisible()
			await options.getByRole("option", { name: label, exact: true }).click()
		}

		await pickTheme("Dark")
		await expect.poll(() => page.evaluate(() => localStorage.getItem("theme"))).toBe("dark")
		await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true)

		await pickTheme("Light")
		await expect.poll(() => page.evaluate(() => localStorage.getItem("theme"))).toBe("light")
		await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("light"))).toBe(true)

		await pickTheme("System")
		await expect.poll(() => page.evaluate(() => localStorage.getItem("theme"))).toBe("system")
	})

	test("every settings section is reachable from the sidebar in one pass, with no console errors", async ({ page }) => {
		await gotoSettings(page)

		// Scoped to the settings leg alone (post-boot, post-navigation-into-settings), same convention as
		// drive.spec.ts's Links-nav console-error capture — the account query's own boot fetch is not part
		// of what this test is asserting.
		const consoleErrors = trackConsoleErrors(page)

		const sections = ["Account", "Security", "Appearance", "Events", "Billing", "Advanced"]

		for (const label of sections) {
			await openSettingsSection(page, label)
		}

		expect(consoleErrors, consoleErrors.join("\n")).toEqual([])
	})

	test("GDPR export downloads a JSON file", async ({ page }) => {
		await gotoSettings(page)
		await waitForAccountLoaded(page)

		// The write budget, not a UI one: the export is assembled from a live getGdprInfo round trip
		// against the shared account before a byte is offered to the browser.
		const [download] = await Promise.all([
			page.waitForEvent("download", { timeout: LIVE_WRITE_TIMEOUT_MS }),
			page.getByRole("button", { name: "Export data", exact: true }).click()
		])

		expect(download.suggestedFilename()).toMatch(/^filen-data-export\.\d+\.json$/)

		const path = await download.path()
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
		expect(parsed).toMatchObject({ user: expect.any(Object), events: expect.any(Object) })
	})

	test("the Advanced section renders working Terms of Service and Privacy Policy links", async ({ page }) => {
		await gotoSettings(page)

		await openSettingsSection(page, "Advanced")

		// Asserted, never clicked — a real click would leave the app on an external filen.io page, and
		// every assertion after it would run against that.
		const tos = page.getByRole("link", { name: "Terms of Service", exact: true })
		await expect(tos).toBeVisible()
		await expect(tos).toHaveAttribute("href", "https://filen.io/terms")
		await expect(tos).toHaveAttribute("target", "_blank")
		await expect(tos).toHaveAttribute("rel", "noopener noreferrer")

		const privacy = page.getByRole("link", { name: "Privacy Policy", exact: true })
		await expect(privacy).toBeVisible()
		await expect(privacy).toHaveAttribute("href", "https://filen.io/privacy")
		await expect(privacy).toHaveAttribute("target", "_blank")
		await expect(privacy).toHaveAttribute("rel", "noopener noreferrer")
	})

	test("the Advanced section opens the lazily-loaded open source licenses dialog", async ({ page }) => {
		await gotoSettings(page)

		await openSettingsSection(page, "Advanced")

		// The only real proof that the lazily-imported payload chunk loads under the hardened preview CSP.
		await page.getByRole("button", { name: "View licenses", exact: true }).click()

		await expect(page.getByRole("heading", { name: "Open source licenses" })).toBeVisible()

		// The list is virtualized over ~1300 rows, so any given package is outside the initial window —
		// filter for it first rather than expecting it on screen.
		await page.getByRole("searchbox", { name: "Filter packages" }).fill("react")

		await expect(page.getByRole("button", { name: /^react /, exact: false }).first()).toBeVisible()
	})
})
