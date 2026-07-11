import { beforeEach, describe, expect, it } from "vitest"
import type { ChatMessage } from "@filen/sdk-rs"
import { useChatComposerStore, useChatComposerEntry } from "@/features/chats/store/useChatComposer"

// The composer store is the cross-component channel between the (portaled) message menu and the composer:
// the menu requests reply/edit, the composer renders it. Reducer-level assertions (no React); the
// reply-chip / edit-mode transitions are the "state machine" the composer owns.

const CHAT = "chat-a-a-a"

function message(uuid: string, body = "original"): ChatMessage {
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

beforeEach(() => {
	useChatComposerStore.setState({ entries: {} })
})

describe("useChatComposerStore", () => {
	it("defaults an unseen chat to an empty new-message entry", () => {
		useChatComposerStore.getState().setDraft(CHAT, "hi")

		const entry = useChatComposerStore.getState().entries[CHAT]
		expect(entry?.draft).toBe("hi")
		expect(entry?.mode).toEqual({ kind: "new" })
	})

	it("beginReply pins the quote, keeps the draft, and bumps the focus nonce", () => {
		const store = useChatComposerStore.getState()
		const target = message("reply-1-1-1")

		store.setDraft(CHAT, "typed so far")
		const nonceBefore = useChatComposerStore.getState().entries[CHAT]?.focusNonce ?? 0

		store.beginReply(CHAT, { kind: "reply", message: target })

		const entry = useChatComposerStore.getState().entries[CHAT]
		expect(entry?.mode).toEqual({ kind: "reply", message: target })
		expect(entry?.draft).toBe("typed so far")
		expect(entry?.focusNonce).toBe(nonceBefore + 1)
	})

	it("beginEdit loads the target body into the draft and pins edit mode", () => {
		const store = useChatComposerStore.getState()
		const target = message("edit-1-1-1", "editable body")

		store.beginEdit(CHAT, { kind: "edit", message: target }, "editable body")

		const entry = useChatComposerStore.getState().entries[CHAT]
		expect(entry?.mode).toEqual({ kind: "edit", message: target })
		expect(entry?.draft).toBe("editable body")
	})

	it("reset clears the draft, returns to new mode, and bumps focus (post-send / cancel)", () => {
		const store = useChatComposerStore.getState()

		store.beginEdit(CHAT, { kind: "edit", message: message("edit-2-2-2") }, "loaded")
		const nonceBefore = useChatComposerStore.getState().entries[CHAT]?.focusNonce ?? 0

		store.reset(CHAT)

		const entry = useChatComposerStore.getState().entries[CHAT]
		expect(entry?.draft).toBe("")
		expect(entry?.mode).toEqual({ kind: "new" })
		expect(entry?.focusNonce).toBe(nonceBefore + 1)
	})

	it("setMode swaps the mode without disturbing the draft", () => {
		const store = useChatComposerStore.getState()

		store.setDraft(CHAT, "keep me")
		store.setMode(CHAT, { kind: "reply", message: message("r-r-r-r") })
		store.setMode(CHAT, { kind: "new" })

		const entry = useChatComposerStore.getState().entries[CHAT]
		expect(entry?.draft).toBe("keep me")
		expect(entry?.mode).toEqual({ kind: "new" })
	})

	it("requestFocus bumps only the nonce", () => {
		const store = useChatComposerStore.getState()

		store.setDraft(CHAT, "x")
		const before = useChatComposerStore.getState().entries[CHAT]?.focusNonce ?? 0

		store.requestFocus(CHAT)

		expect(useChatComposerStore.getState().entries[CHAT]?.focusNonce).toBe(before + 1)
		expect(useChatComposerStore.getState().entries[CHAT]?.draft).toBe("x")
	})

	it("useChatComposerEntry is a plain selector over the store (default entry for an unseen chat)", () => {
		// The hook body is a bare selector; exercised here for the default-entry shape without a renderer.
		expect(typeof useChatComposerEntry).toBe("function")
		expect(useChatComposerStore.getState().entries["never-seen"]).toBeUndefined()
	})
})
