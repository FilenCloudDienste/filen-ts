import type { BrowserContext, Locator, Page } from "@playwright/test"
import { test, expect, settleLeases } from "./fixtures"
import { focusEditorSurface } from "./helpers/editor"
import { resolveEditorModKey, resolveModKey } from "./helpers/modkey"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { trackCspViolations } from "./helpers/csp"
import { BOOT_SETTLE_TIMEOUT_MS, bootTo, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import {
	assistantConversation,
	assistantPanel,
	openAssistantPanel,
	scriptAssistant,
	sendAssistantMessage,
	waitForAssistantTurnEnd
} from "./helpers/assistant"
import { assistant } from "@/locales/en/assistant"

// The assistant in notes over the scripted model (helpers/assistant.ts): the selection transform in a note's editor
// (✨ beside the selection and Alt+J, Accept as one step of the editor's undo, Discard), and a reply written from a
// read note acted on: Copy, and Save as note through its confirmation card. The notes lane (accountLock "notes",
// workers: 1): every note here counts against the free plan's 10-note cap, so each test seeds its note through the
// hooks, and a leak guard removes every note the test added, the saved one included. Titles start with "e2e " so the
// next run's sweep also matches anything a killed test leaves.
test.describe.configure({ mode: "default" })

const NOTE_TEXT = "The quarterly report is due on Friday and needs the budget figures."
const SHORTENED = "Report due Friday with budget figures."

// Random enough that concurrent runs never collide on a title.
function uniqueSuffix(): string {
	return `${String(Date.now())}-${String(Math.floor(Math.random() * 100_000))}`
}

async function deleteNoteQuietly(page: Page, uuid: string): Promise<void> {
	try {
		await page.evaluate(id => window.__filenE2E.deleteTestNoteByUuid(id), uuid)
	} catch {
		console.log(`assistant-notes teardown: could not delete note ${uuid} — left for the next run's sweep`)
	}
}

// Runs `body` and removes every note the account gained meanwhile: the notes lane runs one test at a time, so any new
// uuid is this test's (the seeded note and one Save as note created).
async function withNoteLeakGuard(page: Page, body: () => Promise<void>): Promise<void> {
	await waitForE2eHooks(page)

	const before = new Set(await page.evaluate(() => window.__filenE2E.listTestNoteUuids()))

	try {
		await body()
	} finally {
		try {
			for (const uuid of await page.evaluate(() => window.__filenE2E.listTestNoteUuids())) {
				if (!before.has(uuid)) {
					await deleteNoteQuietly(page, uuid)
				}
			}
		} catch {
			console.log("assistant-notes teardown: could not list notes — any note this test leaked is left for the next run's sweep")
		}
	}
}

// A text note seeded through the hooks, then opened from the notes sidebar by its href (its title also appears as the
// empty preview snippet).
async function seedAndOpenTextNote(page: Page, titlePrefix: string): Promise<{ uuid: string; title: string; editor: Locator }> {
	const title = `${titlePrefix} ${uniqueSuffix()}`
	const note = await page.evaluate(args => window.__filenE2E.createTestNoteWithContent("text", args.content, args.title), {
		content: NOTE_TEXT,
		title
	})

	await page.getByRole("link", { name: "Notes", exact: true }).click()
	await page.waitForURL(/\/notes(\/|$)/)
	await page.getByRole("searchbox", { name: "Search notes" }).fill(title)
	await page.locator(`a[href="/notes/${note.uuid}"]`).click()
	await page.waitForURL(new RegExp(`/notes/${note.uuid}$`))

	const editor = page.getByRole("main").locator(".cm-content")

	await expect(editor).toContainText(NOTE_TEXT, { timeout: BOOT_SETTLE_TIMEOUT_MS })

	return { uuid: note.uuid, title, editor }
}

async function selectAll(page: Page, editor: Locator): Promise<void> {
	await focusEditorSurface(editor)
	await page.keyboard.press(`${await resolveEditorModKey(page)}+a`)
}

function resultPopover(page: Page): Locator {
	return page.locator("[data-assistant-transform]")
}

async function pick(page: Page, kind: string): Promise<void> {
	const menu = page.getByRole("menu", { name: assistant.assistantTransformOpen })

	await expect(menu).toBeVisible()
	await menu.getByRole("menuitem", { name: kind, exact: true }).click()
	await expect(menu).toHaveCount(0)
}

function readServerContent(page: Page, uuid: string): Promise<string | null> {
	return page.evaluate(id => window.__filenE2E.readTestNoteContentByUuid(id), uuid)
}

// Firefox and WebKit grant no clipboard read to a page, so there the copy is caught where the app hands it to the
// clipboard.
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

test.describe("assistant selection transform in a note", () => {
	test("✨ beside the selection: Accept replaces it and the editor's undo takes it back", async ({ page }) => {
		const cspViolations = trackCspViolations(page)

		await settleLeases(page)
		await bootTo(page)
		await withNoteLeakGuard(page, async () => {
			const { uuid, editor } = await seedAndOpenTextNote(page, "e2e ai-transform")

			await scriptAssistant(page, { transform: SHORTENED })
			await selectAll(page, editor)

			const sparkle = page.getByRole("button", { name: assistant.assistantTransformOpen, exact: true })

			await expect(sparkle).toBeVisible()
			await sparkle.click()
			await pick(page, assistant.assistantTransformShorten)

			const popover = resultPopover(page)
			const accept = popover.getByRole("button", { name: assistant.assistantTransformAccept })

			await expect(popover).toContainText(SHORTENED)
			await expect(accept).toBeEnabled()
			await accept.click()
			await expect(popover).toHaveCount(0)
			await expect(editor).toHaveText(SHORTENED)

			// One undo step: the original comes back whole, and reaches the server as it was.
			await focusEditorSurface(editor)
			// Undo is the app's keymap binding (editor.undo, codeMirrorShared.ts), which reads "mod" from the user agent,
			// not CodeMirror's own platform check: they disagree on Playwright's WebKit (a Mac user agent on Linux).
			await page.keyboard.press(`${await resolveModKey(page)}+z`)
			await expect(editor).toHaveText(NOTE_TEXT)
			await expect.poll(() => readServerContent(page, uuid), { timeout: LIVE_WRITE_TIMEOUT_MS }).toBe(NOTE_TEXT)
		})
		expect(cspViolations).toEqual([])
	})

	test("Alt+J opens the menu; Discard leaves the note as it was", async ({ page }) => {
		await settleLeases(page)
		await bootTo(page)
		await withNoteLeakGuard(page, async () => {
			const { editor } = await seedAndOpenTextNote(page, "e2e ai-discard")

			await scriptAssistant(page, { transform: SHORTENED })
			await selectAll(page, editor)
			await page.keyboard.press("Alt+j")
			await pick(page, assistant.assistantTransformFixGrammar)

			const popover = resultPopover(page)

			await expect(popover).toContainText(SHORTENED)
			await popover.getByRole("button", { name: assistant.assistantTransformDiscard, exact: true }).click()
			await expect(popover).toHaveCount(0)
			await expect(editor).toHaveText(NOTE_TEXT)
			await expect(editor).toBeFocused()
		})
	})
})

test.describe("assistant act-on-read in notes", () => {
	test("a reply from the open note copies as shown and saves as a new note after its card", async ({ page, context, browserName }) => {
		const cspViolations = trackCspViolations(page)
		const extract = `The report is due Friday; marker ${uniqueSuffix()}.`
		const reply = `Summary: ${extract}`

		if (browserName === "chromium") {
			await context.grantPermissions(["clipboard-read", "clipboard-write"])
		} else {
			await recordClipboardWrites(context)
		}

		await settleLeases(page)
		await bootTo(page)
		await withNoteLeakGuard(page, async () => {
			const { uuid, title } = await seedAndOpenTextNote(page, "e2e ai-save")
			const before = new Set(await page.evaluate(() => window.__filenE2E.listTestNoteUuids()))

			await scriptAssistant(page, {
				route: "notes read",
				steps: [[{ name: "read_note", args: { handle: `{{handle:${title}}}` } }]],
				extract,
				reply
			})
			await openAssistantPanel(page)
			await sendAssistantMessage(page, "Summarize the note I have open")
			await waitForAssistantTurnEnd(page)

			const conversation = assistantConversation(page)
			const row = assistantPanel(page).getByRole("group", { name: assistant.assistantReplyActions, exact: true })

			await expect(conversation.getByText(reply)).toBeVisible()
			// A note was read, no chat: Copy and Save as note, no Draft reply.
			await expect(row.getByRole("button")).toHaveCount(2)

			// Copy: the reply as shown.
			await row.getByRole("button", { name: assistant.assistantReplyCopy, exact: true }).click()
			await expect(page.getByText(assistant.assistantReplyCopied, { exact: true })).toBeVisible()

			if (browserName === "chromium") {
				await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(reply)
			} else {
				await expect.poll(() => page.evaluate(() => (window as unknown as { __e2eCopied: string[] }).__e2eCopied)).toEqual([reply])
			}

			// Save as note: a turn of its own that ends in the card; only Confirm creates the note.
			await row.getByRole("button", { name: assistant.assistantReplySaveNote, exact: true }).click()

			const confirm = assistantPanel(page).getByRole("button", { name: assistant.assistantConfirm, exact: true })

			await expect(confirm).toBeVisible()
			await expect(assistantPanel(page)).toContainText(assistant.assistantSavedNoteTitle.replace("{{name}}", title))
			expect(await page.evaluate(() => window.__filenE2E.listTestNoteUuids())).toHaveLength(before.size)
			await confirm.click()
			await expect(assistantPanel(page).getByText(assistant.assistantProposalDone, { exact: true })).toBeVisible({
				timeout: LIVE_WRITE_TIMEOUT_MS
			})

			let saved: string[] = []

			await expect
				.poll(
					async () => {
						saved = (await page.evaluate(() => window.__filenE2E.listTestNoteUuids())).filter(id => !before.has(id))

						return saved.length
					},
					{ timeout: LIVE_WRITE_TIMEOUT_MS }
				)
				.toBe(1)

			const savedUuid = saved[0] ?? ""

			expect(savedUuid).not.toBe(uuid)
			await expect.poll(() => readServerContent(page, savedUuid), { timeout: LIVE_WRITE_TIMEOUT_MS }).toContain(extract)
		})
		expect(cspViolations).toEqual([])
	})
})
