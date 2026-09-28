import { beforeEach, describe, expect, it } from "vitest"
import type { ChatMessage } from "@filen/sdk-rs"
import { useChatComposerStore } from "@/features/chats/store/useChatComposer"
import { beginMessageEdit, endMessageEdit } from "@/features/chats/lib/composerEdit"

// Starting an edit loads the message body over the composer's draft; ending it (save, cancel, emptied
// input) must bring back whatever was typed before, including a pending reply quote.

const CHAT = "chat-a-a-a"

function message(uuid: string, body: string): ChatMessage {
	return {
		uuid: uuid as ChatMessage["uuid"],
		chat: CHAT,
		senderId: 7,
		senderEmail: "me@filen.io",
		senderNickName: "Me",
		message: body,
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 100n
	}
}

function entry() {
	return useChatComposerStore.getState().entries[CHAT]
}

beforeEach(() => {
	useChatComposerStore.setState({ entries: {} })
})

describe("beginMessageEdit / endMessageEdit", () => {
	it("restores the typed draft once the edit ends", () => {
		useChatComposerStore.getState().setDraft(CHAT, "a long reply in progress")

		beginMessageEdit(CHAT, message("edit-1-1-1", "old text"))

		expect(entry()?.draft).toBe("old text")
		expect(entry()?.mode.kind).toBe("edit")

		endMessageEdit(CHAT)

		expect(entry()?.draft).toBe("a long reply in progress")
		expect(entry()?.mode).toEqual({ kind: "new" })
	})

	it("restores a pending reply quote with its draft", () => {
		const target = message("reply-1-1-1", "quoted")

		useChatComposerStore.getState().setDraft(CHAT, "answer")
		useChatComposerStore.getState().beginReply(CHAT, { kind: "reply", message: target })

		beginMessageEdit(CHAT, message("edit-1-1-1", "old text"))
		endMessageEdit(CHAT)

		expect(entry()?.draft).toBe("answer")
		expect(entry()?.mode).toEqual({ kind: "reply", message: target })
	})

	it("keeps the pre-edit draft when switching from one edit target to another", () => {
		useChatComposerStore.getState().setDraft(CHAT, "typed before")

		beginMessageEdit(CHAT, message("edit-1-1-1", "first"))
		beginMessageEdit(CHAT, message("edit-2-2-2", "second"))

		expect(entry()?.draft).toBe("second")

		endMessageEdit(CHAT)

		expect(entry()?.draft).toBe("typed before")
	})

	it("ends in an empty new-message composer when nothing was typed, bumping focus", () => {
		beginMessageEdit(CHAT, message("edit-1-1-1", "old text"))
		const nonceBefore = entry()?.focusNonce ?? 0

		endMessageEdit(CHAT)

		expect(entry()?.draft).toBe("")
		expect(entry()?.mode).toEqual({ kind: "new" })
		expect(entry()?.focusNonce).toBe(nonceBefore + 1)
	})

	it("does not restore a draft from an edit that already ended", () => {
		useChatComposerStore.getState().setDraft(CHAT, "typed before")

		beginMessageEdit(CHAT, message("edit-1-1-1", "old text"))
		endMessageEdit(CHAT)
		useChatComposerStore.getState().reset(CHAT)

		beginMessageEdit(CHAT, message("edit-2-2-2", "other"))
		endMessageEdit(CHAT)

		expect(entry()?.draft).toBe("")
	})

	it("leaves the composer alone when the edit being saved is no longer the active one", () => {
		useChatComposerStore.getState().setDraft(CHAT, "typed before")

		beginMessageEdit(CHAT, message("edit-1-1-1", "old text"))
		// Cancelled while the save was in flight, then typing resumed.
		endMessageEdit(CHAT)
		useChatComposerStore.getState().setDraft(CHAT, "typed after")

		endMessageEdit(CHAT, "edit-1-1-1")

		expect(entry()?.draft).toBe("typed after")

		// Moved on to another message's edit: the first save must not end it.
		beginMessageEdit(CHAT, message("edit-2-2-2", "other"))
		endMessageEdit(CHAT, "edit-1-1-1")

		expect(entry()?.mode.kind).toBe("edit")
		expect(entry()?.draft).toBe("other")

		endMessageEdit(CHAT, "edit-2-2-2")

		expect(entry()?.draft).toBe("typed after")
	})
})
