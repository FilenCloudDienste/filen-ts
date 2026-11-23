import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { bootTo, BOOT_SETTLE_TIMEOUT_MS } from "./helpers/listing"
import { gotoSettings, openSettingsSection } from "./helpers/settings"
import { trackCspViolations } from "./helpers/csp"
import {
	assistantConversation,
	assistantPanel,
	openAssistantPanel,
	scriptAssistant,
	sendAssistantMessage,
	waitForAssistantTurnEnd
} from "./helpers/assistant"

// The assistant and Settings, read-only: app help opens the setting it found with the row ringed, and the Keep
// conversations setting asks before a choice that removes saved conversations. Both touch only this device (the
// retention is a kv preference, saved conversations live in kv), never the account, so they run in the read lane.
// The model is the scripted stub (helpers/assistant.ts).

const RETENTION_TITLE = "Keep conversations"
const RETENTION_ANCHOR = "help-assistantRetention"

// Records the id of every element the help highlight rings (data-help-highlight), which it clears again after 2s.
async function recordHighlights(page: Page): Promise<void> {
	await page.evaluate(() => {
		const ringed: string[] = []

		Reflect.set(window, "__helpHighlights", ringed)
		new MutationObserver(records => {
			for (const record of records) {
				const target = record.target

				if (target instanceof Element && target.hasAttribute("data-help-highlight")) {
					ringed.push(target.id === "" ? (target.closest("[id]")?.id ?? "") : target.id)
				}
			}
		}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-help-highlight"] })
	})
}

function highlights(page: Page): Promise<string[]> {
	return page.evaluate(() => Reflect.get(window, "__helpHighlights") as string[])
}

function retentionSelect(page: Page) {
	return page.getByRole("combobox", { name: RETENTION_TITLE })
}

// The choice the select shows: its value slot, without the trigger's chevron (Base UI's Select.Icon puts a "▼" text
// node in it, which the trigger's own text would carry).
function retentionValue(page: Page) {
	return retentionSelect(page).locator('[data-slot="select-value"]')
}

// Opened from the keyboard, as settings.spec.ts's theme switch does: a pointer release can re-select the current item.
async function chooseRetention(page: Page, label: string): Promise<void> {
	await expect(page.getByRole("listbox")).toHaveCount(0)
	await retentionSelect(page).focus()
	await page.keyboard.press("Enter")

	const options = page.getByRole("listbox").last()

	await expect(options).toBeVisible()
	await options.getByRole("option", { name: label, exact: true }).click()
}

test.describe("assistant and settings", () => {
	test("app help opens the setting it found and rings its row", async ({ page }) => {
		test.setTimeout(240_000)

		const cspViolations = trackCspViolations(page)

		await bootTo(page)
		await scriptAssistant(page, {
			route: "help read",
			steps: [
				[{ name: "app_help", args: { query: "keep conversations" } }],
				[{ name: "open_route", args: { route: "settings_assistant", help: `{{handle:${RETENTION_TITLE}}}` } }]
			],
			reply: "It's under Settings → Assistant → Keep conversations."
		})
		await openAssistantPanel(page)
		await recordHighlights(page)
		await sendAssistantMessage(page, "Where do I set how long assistant conversations are kept?")
		await waitForAssistantTurnEnd(page)

		await page.waitForURL(/\/settings\/assistant$/u, { timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(page.getByRole("heading", { level: 1, name: "Assistant", exact: true })).toBeVisible({
			timeout: BOOT_SETTLE_TIMEOUT_MS
		})
		await expect(retentionSelect(page)).toBeVisible()
		await expect.poll(() => highlights(page), { timeout: 15_000 }).toContain(RETENTION_ANCHOR)
		await expect(assistantConversation(page).getByText("It's under Settings → Assistant → Keep conversations.")).toBeVisible()

		expect(cspViolations).toEqual([])
	})

	test("Keep conversations asks before removing saved conversations, and Cancel keeps the old choice", async ({ page }) => {
		test.setTimeout(240_000)

		const cspViolations = trackCspViolations(page)
		const firstMessage = "Say hello to the e2e stub"

		// One saved conversation on this device.
		await bootTo(page)
		await scriptAssistant(page, { route: "answer", reply: "Hello from the stub." })
		await openAssistantPanel(page)
		await sendAssistantMessage(page, firstMessage)
		await waitForAssistantTurnEnd(page)
		await expect(assistantConversation(page).getByText("Hello from the stub.")).toBeVisible()

		const historyToggle = assistantPanel(page).getByRole("button", { name: "Conversation history", exact: true })
		const savedList = assistantPanel(page).getByRole("navigation", { name: "Saved conversations" })

		await historyToggle.click()
		await expect(savedList.getByText(firstMessage)).toBeVisible({ timeout: 15_000 })
		await historyToggle.click()

		await gotoSettings(page)
		await openSettingsSection(page, "Assistant")
		await expect(retentionValue(page)).toHaveText("Forever")

		const confirm = page.getByRole("alertdialog", { name: "Remove saved conversations?" })

		// Off removes every saved conversation, so it asks; Cancel keeps Forever.
		await chooseRetention(page, "Off")
		await expect(confirm).toBeVisible()
		await expect(confirm).toContainText(/removed from this device/u)
		await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
		await expect(confirm).toHaveCount(0)
		await expect(retentionValue(page)).toHaveText("Forever")

		// Confirmed, the choice applies and the saved conversation is gone.
		await chooseRetention(page, "Off")
		await expect(confirm).toBeVisible()
		await confirm.getByRole("button", { name: "Remove", exact: true }).click()
		await expect(confirm).toHaveCount(0)
		await expect(retentionValue(page)).toHaveText("Off")

		await scriptAssistant(page)
		await openAssistantPanel(page)
		await historyToggle.click()
		await expect(assistantPanel(page).getByText("No saved conversations yet", { exact: true })).toBeVisible()

		expect(cspViolations).toEqual([])
	})
})
