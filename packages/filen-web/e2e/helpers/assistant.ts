import type { Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"
import type { AssistantStubRequest, AssistantStubScript } from "../global"
import { waitForE2eHooks } from "./e2eHooks"

// The assistant specs drive the real loop, guard, tool adapters and cards over a scripted model
// (src/e2e-hooks/assistantStub.ts): the shipped model is a 2.7 GB download no CI runner can run. A script answers
// each kind of request the loop makes (router, tool steps, closing reply, extraction, transform, formula, draft);
// "{{handle:NAME}}" in a step's arguments becomes the handle the request shows for NAME.
export type { AssistantStubRequest, AssistantStubScript }

// Plugs the stub in (first call) and sets the script the next requests answer from, restarting its steps. Call it on
// a booted app page (it waits for the e2e hooks), before the panel opens, and again before each turn that needs a
// different script. The context line names the open directory by its path; "{{handle:NAME}}" also matches a path's
// last part.
export async function scriptAssistant(page: Page, script: AssistantStubScript = {}): Promise<void> {
	await waitForE2eHooks(page)
	await page.evaluate(next => {
		window.__filenE2E.assistantStub(next)
	}, script)
}

// Every request the scripted model answered so far, oldest first; `last` is the request's last message (a tool
// result for a step after a call, the data for an extraction).
export function assistantRequests(page: Page): Promise<AssistantStubRequest[]> {
	return page.evaluate(() => window.__filenE2E.assistantStubRequests())
}

// The panel landmark, inline or the narrow-screen drawer.
export function assistantPanel(page: Page): Locator {
	return page.getByRole("complementary", { name: "Assistant", exact: true })
}

export function assistantComposer(page: Page): Locator {
	return assistantPanel(page).getByRole("textbox", { name: "Ask the assistant" })
}

export function assistantConversation(page: Page): Locator {
	return assistantPanel(page).getByRole("region", { name: "Conversation" })
}

// The rail's toggle: its name changes with a turn's cue while the panel is hidden, so it is found by its id.
export function assistantRailToggle(page: Page): Locator {
	return page.locator("#assistant-toggle")
}

// Opens the panel from the rail unless it already shows, and waits for the composer (the stub reports a ready model).
export async function openAssistantPanel(page: Page): Promise<void> {
	if (!(await assistantPanel(page).isVisible())) {
		await assistantRailToggle(page).click()
	}

	await expect(assistantComposer(page)).toBeVisible()
}

// Types `text` and sends it with the Send button; the turn runs on the stub.
export async function sendAssistantMessage(page: Page, text: string): Promise<void> {
	const composer = assistantComposer(page)

	await composer.fill(text)
	await assistantPanel(page).getByRole("button", { name: "Send", exact: true }).click()
	await expect(composer).toHaveValue("")
}

// Settles once the running turn ended: the composer's Stop button turned back into Send.
export async function waitForAssistantTurnEnd(page: Page, timeout = 30_000): Promise<void> {
	await expect(assistantPanel(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout })
}
