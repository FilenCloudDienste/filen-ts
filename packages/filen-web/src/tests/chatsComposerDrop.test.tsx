// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Chat } from "@filen/sdk-rs"

// Dropping files on the composer starts an upload, so it answers to the same gate as the attach menu:
// offline, on a free account, or while an attachment is still uploading, the drop is refused with a
// reason instead of uploading a file whose link can only fail (or racing the one in flight). Also the
// edit mode's emptied-input behaviour, the reply banner, the suggestion listbox's keyboard/ARIA wiring, the
// immediate draft delete on send, and the over-limit counter and error tied to the field.

const { state, preflightAttachments, uploadAttachment, toastError, navigate, deleteDraft, saveDraftDebounced } = vi.hoisted(() => ({
	navigate: vi.fn(),
	deleteDraft: vi.fn(() => Promise.resolve()),
	saveDraftDebounced: vi.fn(),
	// Pro follows the subscriptions (isProAccount, the backend's isUserPro), never the account's isPremium flag:
	// the default here is a subscriber whose isPremium is false, as it is for every subscription-only account.
	state: { isOnline: true, subs: [{ activated: true }] as { activated: boolean }[], isPremium: false },
	preflightAttachments: vi.fn<(files: File[]) => Promise<boolean>>(() => Promise.resolve(true)),
	uploadAttachment: vi.fn<(file: File) => Promise<{ status: "success"; url: string }>>(),
	toastError: vi.fn()
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => state.isOnline }))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { isPremium: state.isPremium, subs: state.subs } }) }))
vi.mock("@/features/chats/lib/attachments", () => ({ preflightAttachments, uploadAttachment }))
vi.mock("@/features/chats/lib/sync", () => ({ enqueueChatMessage: vi.fn(() => Promise.resolve(true)) }))
vi.mock("@/features/chats/lib/typing", () => ({ signalTyping: vi.fn(), signalStopped: vi.fn() }))
vi.mock("@/features/chats/lib/drafts", () => ({ loadDraft: () => Promise.resolve(""), saveDraftDebounced, deleteDraft }))
vi.mock("@/features/chats/components/thread/attachDriveDialog", () => ({ AttachDriveDialog: () => null }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))

import "@/lib/i18n"
import { Composer } from "@/features/chats/components/thread/composer"
import { beginMessageEdit } from "@/features/chats/lib/composerEdit"
import { useChatComposerStore } from "@/features/chats/store/useChatComposer"
import { MAX_CHAT_MESSAGE_LENGTH } from "@/features/chats/lib/composer.logic"
import { registerAllActions } from "@/lib/keymap/actions"
import { mockChatMessage, mockChatParticipant, mockUndecryptableChat } from "@/tests/fixtures/sdk"

// The composer reads its keys from the registry.
registerAllActions()

const CHAT = mockUndecryptableChat({ uuid: "chat-0000-0000-0000-000000000000" })

function renderComposer(): HTMLElement {
	const { container } = render(
		createElement(Composer, { chat: CHAT, messages: [], nonConfirmedUuids: new Set<string>(), onSent: vi.fn() })
	)
	const root = container.firstElementChild

	if (!(root instanceof HTMLElement)) {
		throw new Error("composer not rendered")
	}

	return root
}

async function dropFile(target: HTMLElement): Promise<boolean> {
	const file = new File(["x"], "clip.mp4", { type: "video/mp4" })
	let notPrevented = true

	await act(async () => {
		notPrevented = fireEvent.drop(target, { dataTransfer: { files: [file] } })
		await Promise.resolve()
	})

	return notPrevented
}

beforeEach(() => {
	state.isOnline = true
	state.subs = [{ activated: true }]
	state.isPremium = false
})

describe("Composer — dropping files", () => {
	it("refuses the drop offline, without uploading, and keeps the browser from opening the file", async () => {
		state.isOnline = false

		const notPrevented = await dropFile(renderComposer())

		expect(notPrevented).toBe(false)
		expect(preflightAttachments).not.toHaveBeenCalled()
		expect(uploadAttachment).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledWith("Unavailable while offline")
	})

	it("refuses the drop on a free account, without uploading", async () => {
		state.subs = []

		await dropFile(renderComposer())

		expect(uploadAttachment).not.toHaveBeenCalled()
		expect(toastError.mock.calls[0]?.[0]).toBe("Attachments require a Pro subscription")
		expect(toastError.mock.calls[0]?.[1]).toHaveProperty("action")

		// The toast's Upgrade opens the plans.
		const options = toastError.mock.calls[0]?.[1] as { action: { label: string; onClick: () => void } }

		expect(options.action.label).toBe("Upgrade")
		options.action.onClick()
		expect(navigate).toHaveBeenCalledWith({ to: "/settings/plans" })
	})

	it("refuses the drop when only the one-off isPremium flag is set and no subscription is active", async () => {
		state.subs = [{ activated: false }]
		state.isPremium = true

		await dropFile(renderComposer())

		expect(uploadAttachment).not.toHaveBeenCalled()
		expect(toastError.mock.calls[0]?.[0]).toBe("Attachments require a Pro subscription")
		expect(toastError.mock.calls[0]?.[1]).toHaveProperty("action")
	})

	it("refuses a second drop while an attachment is still uploading", async () => {
		uploadAttachment.mockImplementationOnce(() => new Promise(() => undefined))

		const root = renderComposer()

		await dropFile(root)
		await dropFile(root)

		expect(uploadAttachment).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith("Wait for the current attachment to finish uploading")
	})

	it("accepts the next drop once an upload has settled, and appends its link to the draft", async () => {
		uploadAttachment.mockImplementation(() => Promise.resolve({ status: "success", url: "https://filen.io/d/link" }))

		const root = renderComposer()

		await dropFile(root)
		await dropFile(root)

		expect(uploadAttachment).toHaveBeenCalledTimes(2)
		expect(toastError).not.toHaveBeenCalled()
		expect(useChatComposerStore.getState().entries[CHAT.uuid]?.draft).toContain("https://filen.io/d/link")
	})

	it("refuses a second drop while the first one's quota pre-flight is still reading", async () => {
		preflightAttachments.mockImplementationOnce(() => new Promise(() => undefined))

		const root = renderComposer()

		await dropFile(root)
		await dropFile(root)

		expect(preflightAttachments).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith("Wait for the current attachment to finish uploading")
	})

	it("names the file whose upload failed", async () => {
		uploadAttachment.mockImplementationOnce(() =>
			Promise.resolve({ status: "error", dto: { species: "plain", label: "Network error", message: "Network error" } } as never)
		)

		await dropFile(renderComposer())

		expect(toastError).toHaveBeenCalledWith("Couldn't attach clip.mp4", { description: "Network error" })
	})
})

// Pasting files into the message field attaches them through the drop's gate; a paste with text stays a text paste.
describe("Composer — pasting files", () => {
	function paste(files: File[], text = ""): boolean {
		const field = screen.getByRole("textbox")
		let notPrevented = true

		act(() => {
			notPrevented = fireEvent.paste(field, {
				clipboardData: { files, getData: (type: string) => (type === "text/plain" ? text : "") }
			})
		})

		return notPrevented
	}

	const IMAGE = new File(["x"], "image.png", { type: "image/png" })

	it("attaches a pasted image and keeps it out of the field", async () => {
		uploadAttachment.mockImplementation(() => Promise.resolve({ status: "success", url: "https://filen.io/d/pasted" }))
		renderComposer()

		expect(paste([IMAGE])).toBe(false)

		await act(async () => {
			await Promise.resolve()
		})

		expect(preflightAttachments).toHaveBeenCalledWith([IMAGE])
		expect(uploadAttachment).toHaveBeenCalledWith(IMAGE)
	})

	it("leaves a paste carrying text to the field, even with a picture of it beside", () => {
		renderComposer()

		expect(paste([IMAGE], "copied cells")).toBe(true)
		expect(paste([], "plain text")).toBe(true)
		expect(preflightAttachments).not.toHaveBeenCalled()
	})

	it("refuses a pasted file offline with the reason", () => {
		state.isOnline = false
		renderComposer()

		expect(paste([IMAGE])).toBe(false)
		expect(uploadAttachment).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledWith("Unavailable while offline")
	})

	it("refuses a pasted file on a free account", () => {
		state.subs = []
		renderComposer()

		paste([IMAGE])

		expect(uploadAttachment).not.toHaveBeenCalled()
		expect(toastError.mock.calls[0]?.[0]).toBe("Attachments require a Pro subscription")
	})
})

const EDITED = mockChatMessage({
	uuid: "edit-0000-0000-0000-000000000000",
	chat: CHAT.uuid,
	senderEmail: "me@filen.io",
	message: "old text"
})

describe("Composer — attach menu on a free account", () => {
	it("opens with the reason and an Upgrade to the plans instead of the attach entries", async () => {
		state.subs = []
		renderComposer()

		const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "Attach" })

		expect(trigger.disabled).toBe(false)

		await act(async () => {
			trigger.focus()
			fireEvent.keyDown(trigger, { key: "ArrowDown" })
			await Promise.resolve()
		})

		expect(screen.queryByRole("menuitem", { name: "Upload a file" })).toBeNull()
		expect(screen.getByText("Attachments require a Pro subscription")).toBeDefined()

		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Upgrade" }))
			await Promise.resolve()
		})

		expect(navigate).toHaveBeenCalledWith({ to: "/settings/plans" })
	})

	it("stays off offline", () => {
		state.subs = []
		state.isOnline = false
		renderComposer()

		const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "Attach" })

		// Off but hoverable, so its tooltip and description say why.
		expect(trigger.getAttribute("aria-disabled")).toBe("true")
		expect(document.getElementById(trigger.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Unavailable while offline")

		fireEvent.click(trigger)

		expect(screen.queryByRole("menuitem", { name: "Upload a file" })).toBeNull()
	})
})

describe("Composer — editing", () => {
	it("keeps an edit open when its input is emptied, instead of putting the pre-edit draft back under the cursor", () => {
		useChatComposerStore.getState().setDraft(CHAT.uuid, "a reply in progress")
		beginMessageEdit(CHAT.uuid, EDITED)

		renderComposer()

		const input = screen.getByRole("textbox", { name: "Message" })

		fireEvent.change(input, { target: { value: "" } })

		expect(useChatComposerStore.getState().entries[CHAT.uuid]?.mode.kind).toBe("edit")
		expect(input).toHaveProperty("value", "")

		fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }))

		expect(useChatComposerStore.getState().entries[CHAT.uuid]?.draft).toBe("a reply in progress")
	})
})

const PARTICIPANT_CHAT: Chat = {
	...CHAT,
	uuid: "chat-1111-1111-1111-111111111111",
	participants: [
		mockChatParticipant({ userId: 2n, email: "alice@filen.io" }),
		mockChatParticipant({ userId: 3n, email: "alfred@filen.io" })
	]
}

describe("Composer — reply banner", () => {
	it("shows who is being replied to, and cancelling keeps the typed text", () => {
		const chatUuid = "chat-2222-2222-2222-222222222222"

		useChatComposerStore.getState().setDraft(chatUuid, "typed")
		useChatComposerStore
			.getState()
			.setMode(chatUuid, { kind: "reply", message: { ...EDITED, chat: chatUuid, message: "the quoted text" } })

		render(
			createElement(Composer, {
				chat: { ...CHAT, uuid: chatUuid },
				messages: [],
				nonConfirmedUuids: new Set<string>(),
				onSent: vi.fn()
			})
		)

		expect(screen.getByText(/Replying to/)).toBeTruthy()
		expect(screen.getByText("the quoted text")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }))

		expect(useChatComposerStore.getState().entries[chatUuid]?.mode.kind).toBe("new")
		expect(useChatComposerStore.getState().entries[chatUuid]?.draft).toBe("typed")
		expect(screen.queryByText(/Replying to/)).toBeNull()
	})
})

describe("Composer — mention suggestions", () => {
	function openMentions(): HTMLElement {
		render(createElement(Composer, { chat: PARTICIPANT_CHAT, messages: [], nonConfirmedUuids: new Set<string>(), onSent: vi.fn() }))

		const input = screen.getByRole("textbox", { name: "Message" })

		fireEvent.change(input, { target: { value: "hi @al" } })

		return input
	}

	it("announces how many suggestions opened", () => {
		openMentions()

		expect(screen.getByText("2 suggestions available")).toBeTruthy()
	})

	it("exposes the popover as a listbox the input controls, tracking the active option", () => {
		const input = openMentions()
		const listbox = screen.getByRole("listbox")
		const options = screen.getAllByRole("option")

		expect(options).toHaveLength(2)
		expect(input.getAttribute("aria-expanded")).toBe("true")
		expect(input.getAttribute("aria-controls")).toBe(listbox.id)
		expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id)
		expect(options[0]?.getAttribute("aria-selected")).toBe("true")

		fireEvent.keyDown(input, { key: "ArrowDown" })

		expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id)
		expect(options[1]?.getAttribute("aria-selected")).toBe("true")
	})

	it("completes the active option on Enter and closes the listbox", () => {
		const input = openMentions()
		const second = screen.getAllByRole("option")[1]?.textContent ?? ""

		fireEvent.keyDown(input, { key: "ArrowDown" })
		fireEvent.keyDown(input, { key: "Enter" })

		const draft = useChatComposerStore.getState().entries[PARTICIPANT_CHAT.uuid]?.draft ?? ""

		expect(second).toContain(draft.slice(4).trim())
		expect(draft).toMatch(/^hi @\S+@filen\.io $/)
		expect(screen.queryByRole("listbox")).toBeNull()
		expect(input.getAttribute("aria-expanded")).toBe("false")
		expect(input.hasAttribute("aria-activedescendant")).toBe(false)
	})

	it("closes on Escape without touching the draft", () => {
		const input = openMentions()

		fireEvent.keyDown(input, { key: "Escape" })

		expect(screen.queryByRole("listbox")).toBeNull()
		expect(useChatComposerStore.getState().entries[PARTICIPANT_CHAT.uuid]?.draft).toBe("hi @al")
	})

	it("completes an option picked with the pointer", () => {
		openMentions()

		const option = screen.getAllByRole("option")[0]

		if (option === undefined) {
			throw new Error("no option")
		}

		fireEvent.mouseDown(option)

		expect(useChatComposerStore.getState().entries[PARTICIPANT_CHAT.uuid]?.draft).toMatch(/^hi @\S+@filen\.io $/)
	})
})

describe("Composer — sending", () => {
	it("deletes the persisted draft at once instead of through the debounce", () => {
		deleteDraft.mockClear()
		saveDraftDebounced.mockClear()
		renderComposer()

		const input = screen.getByRole("textbox", { name: "Message" })

		fireEvent.change(input, { target: { value: "hello" } })
		saveDraftDebounced.mockClear()
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" })

		expect(deleteDraft).toHaveBeenCalledWith(CHAT.uuid)
		expect(saveDraftDebounced).not.toHaveBeenCalledWith(CHAT.uuid, "hello")
	})
})

describe("Composer — length limit", () => {
	// The description as assistive tech reads it: aria-hidden descendants of a referenced node are left out.
	function describedText(input: HTMLElement): string {
		return (input.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map(id => {
				const clone = document.getElementById(id)?.cloneNode(true)

				if (!(clone instanceof HTMLElement)) {
					return ""
				}

				for (const hidden of clone.querySelectorAll("[aria-hidden='true']")) {
					hidden.remove()
				}

				return clone.textContent
			})
			.join(" ")
	}

	it("ties the counter and the error to the field while over the limit", () => {
		renderComposer()

		const input = screen.getByRole("textbox", { name: "Message" })

		fireEvent.change(input, { target: { value: "a".repeat(MAX_CHAT_MESSAGE_LENGTH + 3) } })

		const errorId = input.getAttribute("aria-errormessage")
		const error = errorId !== null ? document.getElementById(errorId) : null

		expect(input.getAttribute("aria-invalid")).toBe("true")
		expect(error?.textContent).toMatch(/^Message is too long/)
		expect(error?.getAttribute("role")).toBe("alert")
		expect(describedText(input)).toContain("3 characters over the limit")
		expect(describedText(input)).toContain("Message is too long")
	})

	it("names the counter near the limit without marking the field invalid", () => {
		renderComposer()

		const input = screen.getByRole("textbox", { name: "Message" })

		fireEvent.change(input, { target: { value: "a".repeat(MAX_CHAT_MESSAGE_LENGTH - 1) } })

		expect(describedText(input)).toBe("1 character remaining")
		expect(input.hasAttribute("aria-errormessage")).toBe(false)
	})

	it("sets neither reference well under the limit", () => {
		renderComposer()

		const input = screen.getByRole("textbox", { name: "Message" })

		fireEvent.change(input, { target: { value: "short" } })

		expect(input.hasAttribute("aria-describedby")).toBe(false)
		expect(input.hasAttribute("aria-errormessage")).toBe(false)
	})
})
