// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Chat, ChatMessage } from "@filen/sdk-rs"

// Dropping files on the composer starts an upload, so it answers to the same gate as the attach menu:
// offline, on a free account, or while an attachment is still uploading, the drop is refused with a
// reason instead of uploading a file whose link can only fail (or racing the one in flight). Also the
// edit mode's emptied-input behaviour.

const { state, preflightAttachments, uploadAttachment, toastError } = vi.hoisted(() => ({
	state: { isOnline: true, isPremium: true },
	preflightAttachments: vi.fn<(files: File[]) => Promise<boolean>>(() => Promise.resolve(true)),
	uploadAttachment: vi.fn<(file: File) => Promise<{ status: "success"; url: string }>>(),
	toastError: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => state.isOnline }))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { isPremium: state.isPremium } }) }))
vi.mock("@/features/chats/lib/attachments", () => ({ preflightAttachments, uploadAttachment }))
vi.mock("@/features/chats/lib/sync", () => ({ enqueueChatMessage: vi.fn() }))
vi.mock("@/features/chats/lib/typing", () => ({ signalTyping: vi.fn(), signalStopped: vi.fn() }))
vi.mock("@/features/chats/lib/drafts", () => ({ loadDraft: () => Promise.resolve(""), saveDraftDebounced: vi.fn() }))
vi.mock("@/features/chats/components/thread/attachDriveDialog", () => ({ AttachDriveDialog: () => null }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))
// The composer registers with the toast-clearance store, which needs a ResizeObserver jsdom lacks.
vi.mock("@/lib/toastClearance", () => ({ toastObstructionRef: () => undefined }))

import "@/lib/i18n"
import { Composer } from "@/features/chats/components/thread/composer"
import { beginMessageEdit } from "@/features/chats/lib/composerEdit"
import { useChatComposerStore } from "@/features/chats/store/useChatComposer"

const CHAT: Chat = {
	uuid: "chat-0000-0000-0000-000000000000",
	ownerId: 1n,
	participants: [],
	muted: false,
	created: 0n,
	lastFocus: 0n
}

function renderComposer(): HTMLElement {
	const { container } = render(
		createElement(Composer, { chat: CHAT, messages: [], nonConfirmedUuids: new Set<string>(), sender: undefined, onSent: vi.fn() })
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
	state.isPremium = true
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
		state.isPremium = false

		await dropFile(renderComposer())

		expect(uploadAttachment).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledWith("Attachments require a Pro subscription")
	})

	it("refuses a second drop while an attachment is still uploading", async () => {
		uploadAttachment.mockImplementationOnce(() => new Promise(() => undefined))

		const root = renderComposer()

		await dropFile(root)
		await dropFile(root)

		expect(uploadAttachment).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith("Wait for the current attachment to finish uploading")
	})
	it("refuses a second drop while the first one's quota pre-flight is still reading", async () => {
		preflightAttachments.mockImplementationOnce(() => new Promise(() => undefined))

		const root = renderComposer()

		await dropFile(root)
		await dropFile(root)

		expect(preflightAttachments).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith("Wait for the current attachment to finish uploading")
	})
})

const EDITED: ChatMessage = {
	uuid: "edit-0000-0000-0000-000000000000",
	chat: CHAT.uuid,
	senderId: 1,
	senderEmail: "me@filen.io",
	senderNickName: undefined,
	message: "old text",
	embedDisabled: false,
	edited: false,
	editedTimestamp: 0n,
	sentTimestamp: 0n
}

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
