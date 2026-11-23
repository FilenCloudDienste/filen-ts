import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test"
import { test, expect, readFixtureManifest, runChatNamePrefix } from "./fixtures"
import {
	assistantConversation,
	assistantPanel,
	assistantRequests,
	openAssistantPanel,
	scriptAssistant,
	sendAssistantMessage,
	waitForAssistantTurnEnd
} from "./helpers/assistant"
import { trackCspViolations } from "./helpers/csp"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { bootTo, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"

// The assistant's act-on-read row after it read a chat: Copy, Save as note and Draft reply under the reply. The model
// is the scripted stub (helpers/assistant.ts); the read, the extraction, the row, the draft card and the composer are
// the app's own. Save as note creates a note, so it is the notes lane's (assistant-notes.spec.ts), not clicked here.
//
// Runs in the chats lane (playwright.config.ts CHATS_SPEC, account lock "chats") and reuses chats.spec.ts's one shared
// self-chat: the same run-scoped name in the same lane and project, found by name, created only when that spec has not
// made it yet. conversations/create is a hot, long-window rate limit, so this file adds at most one create per run and
// lane, and fixtures-teardown removes the chat with the rest of the run's chats. Each test sends one uniquely worded
// message into it, so what the read returned is provable without an absolute count.
//
// Not covered here: a chat's linked file embed hosts no assistant toggle (assistantSeesPreview). A resolving embed
// needs a public link of a drive file, which is a premium drive write this lane cannot take; the unit suite
// (previewAssistantPane.test.tsx) holds that rule.

const READ_REQUEST = "Summarize this chat"
const READ_SUMMARY = "Anna asks to meet on Friday at noon."
const READ_REPLY = "Anna asks whether you can meet on Friday at noon."
const DRAFT_TEXT = "Friday at noon works for me, see you then."

const CHAT_CREATE_RETRY_TIMEOUT_MS = 90_000
const CHAT_CREATE_RETRY_INTERVALS_MS = [10_000, 20_000, 30_000, 30_000]

let sharedChatUuid: string | undefined
let sharedChatRefusal: string | undefined

function sharedChatName(testInfo: TestInfo): string {
	return `${runChatNamePrefix(readFixtureManifest().runId)}${testInfo.project.name}`
}

function uniqueMessage(prefix: string): string {
	return `${prefix}-${String(Date.now())}-${crypto.randomUUID()}`
}

async function gotoChats(page: Page): Promise<void> {
	await bootTo(page)
	await page.getByRole("link", { name: "Chats", exact: true }).click()
	await page.waitForURL(/\/chats(\/|$)/)
}

// The shared self-chat, found by name or created (retried on a server refusal only, as chats.spec.ts does). A create
// the limiter keeps refusing skips the test with the server's reason; one that never reached the server fails it.
async function sharedChat(page: Page, testInfo: TestInfo): Promise<string> {
	test.skip(sharedChatRefusal !== undefined, `shared self-chat unavailable — ${sharedChatRefusal ?? ""}`)

	if (sharedChatUuid !== undefined) {
		return sharedChatUuid
	}

	const name = sharedChatName(testInfo)

	await waitForE2eHooks(page)

	const existing = await page.evaluate(chatName => window.__filenE2E.findTestChatByName(chatName), name)

	if (existing !== null) {
		sharedChatUuid = existing

		return existing
	}

	// Written from inside the retry callback, so read through an object TypeScript does not narrow.
	const found: { uuid?: string } = {}
	let lastRefusal: string | undefined
	let unreached: string | undefined

	await expect(async () => {
		const before = await page
			.evaluate(() => window.__filenE2E.listTestChatUuids())
			.then(uuids => new Set(uuids))
			.catch(() => undefined)
		const outcome = await page
			.evaluate(async chatName => {
				try {
					return { ok: true as const, uuid: await window.__filenE2E.createTestSelfChat(chatName) }
				} catch (error) {
					const dto = error as Partial<{
						kind: string
						serverCode: string
						serverMessage: string
						label: string
						message: string
					}>

					return {
						ok: false as const,
						reason: `kind=${dto.kind ?? "-"} serverCode=${dto.serverCode ?? "-"} serverMessage=${dto.serverMessage ?? "-"} label=${dto.label ?? dto.message ?? String(error)}`
					}
				}
			}, name)
			.catch((error: unknown) => {
				unreached = error instanceof Error ? error.message : String(error)

				return null
			})

		if (outcome === null) {
			return
		}

		if (outcome.ok) {
			found.uuid = outcome.uuid

			return
		}

		// A rename whose answer was lost after it landed leaves the named chat: take it rather than make a second.
		const landed = await page.evaluate(chatName => window.__filenE2E.findTestChatByName(chatName), name).catch(() => null)

		if (landed !== null) {
			found.uuid = landed

			return
		}

		// createTestSelfChat is createChat then renameChat: a throw between them leaves an unnamed chat no prefix
		// sweep can match, so whatever the attempt added is removed before the retry.
		if (before !== undefined) {
			const after = await page.evaluate(() => window.__filenE2E.listTestChatUuids()).catch(() => [])

			for (const uuid of after.filter(candidate => !before.has(candidate))) {
				await page.evaluate(u => window.__filenE2E.deleteTestChatByUuid(u), uuid).catch(() => undefined)
			}
		}

		lastRefusal = outcome.reason

		throw new Error(`conversations/create refused — ${outcome.reason}`)
	})
		.toPass({ intervals: CHAT_CREATE_RETRY_INTERVALS_MS, timeout: CHAT_CREATE_RETRY_TIMEOUT_MS })
		.catch(() => undefined)

	if (found.uuid !== undefined) {
		sharedChatUuid = found.uuid

		return found.uuid
	}

	if (lastRefusal === undefined) {
		throw new Error(`conversations/create got no server answer — ${unreached ?? "none recorded"}`)
	}

	const warning = `conversations/create refused for ${String(CHAT_CREATE_RETRY_TIMEOUT_MS / 1000)}s, the assistant chat tests are skipped — ${lastRefusal}`

	sharedChatRefusal = `conversations/create never landed — last refusal: ${lastRefusal}`
	testInfo.annotations.push({ type: "warning", description: warning })
	console.warn(`${process.env["CI"] ? "::warning::" : ""}assistant-chats-spec: ${warning}`)
	test.skip(true, sharedChatRefusal)

	throw new Error("unreachable: the test was skipped")
}

// Sends `text` into the chat through the outbox hook and waits until the server has it, so the thread opened next
// lists it and the assistant's read finds it.
async function seedMessage(page: Page, uuid: string, text: string): Promise<void> {
	expect(await page.evaluate(([u, t]) => window.__filenE2E.enqueueTestChatMessage(u, t), [uuid, text] as const)).toBe(true)
	await expect
		.poll(() => page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid), { timeout: LIVE_WRITE_TIMEOUT_MS })
		.toContain(text)
}

function messageInput(page: Page): Locator {
	return page.getByRole("textbox", { name: "Message" })
}

// The thread, opened by its sidebar row (keyed on the uuid: the account can hold other rows under the prefix).
async function openThread(page: Page, uuid: string): Promise<void> {
	const row = page.locator(`a[href*="/chats/${uuid}"]`).first()

	await expect(row).toBeVisible({ timeout: 30_000 })
	await row.click()
	await page.waitForURL(new RegExp(`/chats/${uuid}`))
	await expect(messageInput(page)).toBeVisible({ timeout: 30_000 })
}

// From a fresh page to the assistant's reply on a read of the open chat, its act-on-read row returned. The chat's
// handle comes from the screen context line ("open chat: …"), as the model would copy it.
async function readOpenChat(page: Page, testInfo: TestInfo, seed: string): Promise<{ uuid: string; name: string; row: Locator }> {
	await gotoChats(page)

	const uuid = await sharedChat(page, testInfo)
	const name = sharedChatName(testInfo)

	await seedMessage(page, uuid, seed)
	await openThread(page, uuid)
	await scriptAssistant(page, {
		route: "chats read",
		steps: [[{ name: "read_chat", args: { handle: `{{handle:${name}}}` } }]],
		extract: READ_SUMMARY,
		reply: READ_REPLY,
		draft: DRAFT_TEXT
	})
	await openAssistantPanel(page)
	await sendAssistantMessage(page, READ_REQUEST)
	await waitForAssistantTurnEnd(page)

	const panel = assistantPanel(page)

	// In the transcript: the settled turn's polite announcement (sr-only, outside it) holds the same words.
	await expect(assistantConversation(page).getByText(READ_REPLY, { exact: true })).toBeVisible()

	// The real read_chat adapter read the server's messages: the extraction the stub was asked for holds the seed.
	await expect
		.poll(async () => (await assistantRequests(page)).some(request => request.kind === "extract" && request.last.includes(seed)))
		.toBe(true)

	return { uuid, name, row: panel.getByRole("group", { name: "Use this reply", exact: true }) }
}

// Firefox and WebKit grant no clipboard read to a page, so there the copy is caught where the app hands it to the
// clipboard: navigator.clipboard.writeText records its text and resolves.
async function recordClipboardWrites(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		const copied: string[] = []

		Object.defineProperty(window, "__e2eCopied", { value: copied })
		Object.defineProperty(navigator.clipboard, "writeText", {
			configurable: true,
			value: (text: string) => {
				copied.push(text)

				return Promise.resolve()
			}
		})
	})
}

test.describe("assistant act-on-read in chats", () => {
	test("a read of the open chat shows Copy, Save as note and Draft reply under the reply", async ({ page }, testInfo) => {
		const cspViolations = trackCspViolations(page)
		const { name, row } = await readOpenChat(page, testInfo, uniqueMessage("assistant-read"))

		await expect(row.getByRole("button")).toHaveCount(3)
		await expect(row.getByRole("button", { name: "Copy", exact: true })).toBeEnabled()
		await expect(row.getByRole("button", { name: "Save as note", exact: true })).toBeEnabled()
		await expect(row.getByRole("button", { name: `Draft reply in "${name}"`, exact: true })).toBeEnabled()
		expect(cspViolations).toEqual([])
	})

	test("Copy puts the reply as shown on the clipboard", async ({ page, context, browserName }, testInfo) => {
		const cspViolations = trackCspViolations(page)

		if (browserName === "chromium") {
			await context.grantPermissions(["clipboard-read", "clipboard-write"])
		} else {
			await recordClipboardWrites(context)
		}

		const { row } = await readOpenChat(page, testInfo, uniqueMessage("assistant-copy"))

		await row.getByRole("button", { name: "Copy", exact: true }).click()
		await expect(page.getByText("Copied", { exact: true })).toBeVisible()

		if (browserName === "chromium") {
			await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(READ_REPLY)
		} else {
			await expect.poll(() => page.evaluate(() => (window as unknown as { __e2eCopied: string[] }).__e2eCopied)).toEqual([READ_REPLY])
		}

		expect(cspViolations).toEqual([])
	})

	test("Draft reply fills the chat's composer after the card, and sends nothing", async ({ page }, testInfo) => {
		const cspViolations = trackCspViolations(page)
		const { uuid, name, row } = await readOpenChat(page, testInfo, uniqueMessage("assistant-draft"))

		try {
			const sentBefore = await page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid)

			await expect(messageInput(page)).toHaveValue("")
			await row.getByRole("button", { name: `Draft reply in "${name}"`, exact: true }).click()

			// The card shows exactly what lands, and nothing lands before its button is clicked.
			const panel = assistantPanel(page)
			const addDraft = panel.getByRole("button", { name: "Add draft", exact: true })

			await expect(panel.getByText(`Put this draft into ${name}?`, { exact: true })).toBeVisible()
			await expect(panel.getByText(DRAFT_TEXT, { exact: true })).toBeVisible()
			await expect(panel.getByText("You still send it yourself.", { exact: true })).toBeVisible()
			await expect(messageInput(page)).toHaveValue("")

			await addDraft.click()
			await waitForAssistantTurnEnd(page)

			// The draft sits in this chat's composer, ready for the user to send.
			await expect(page).toHaveURL(new RegExp(`/chats/${uuid}`))
			await expect(messageInput(page)).toHaveValue(DRAFT_TEXT)
			await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled()

			// Nothing was sent: no bubble in the thread, no "Sending…", and the server holds what it held before.
			const thread = page.getByRole("main")

			await expect(thread.getByText(DRAFT_TEXT, { exact: true })).toHaveCount(0)
			await expect(thread.getByText("Sending…", { exact: true })).toHaveCount(0)

			const sentAfter = await page.evaluate(u => window.__filenE2E.readTestChatMessageTexts(u), uuid)

			// Compared as a set of texts: an SDK retry of the seed's lost answer can add a second copy of the seed.
			expect(sentAfter).not.toContain(DRAFT_TEXT)
			expect(sentAfter.filter(text => !sentBefore.includes(text))).toEqual([])
			await expect(messageInput(page)).toHaveValue(DRAFT_TEXT)
			expect(cspViolations).toEqual([])
		} finally {
			// The draft is the user's to send; leave the composer (and its on-device mirror) empty for the next test.
			await messageInput(page)
				.fill("")
				.catch(() => undefined)
		}
	})
})
