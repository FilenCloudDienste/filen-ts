import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("@filen/sdk-rs", () => ({}))

import useChatsStore, {
	withPatchedOlderMessage,
	olderMessagesChatUuid,
	type ChatMessageWithInflightId,
	type OlderChatMessages
} from "@/features/chats/store/useChats.store"
import { makeChatMessage } from "@/tests/fixtures/chats"

function message(uuid: string, text = "text"): ChatMessageWithInflightId {
	return {
		...makeChatMessage({ inner: { uuid, message: text } }),
		inflightId: ""
	}
}

describe("withPatchedOlderMessage", () => {
	const a = [message("m1"), message("m2")]
	const b = [message("m3")]
	const prev: OlderChatMessages = {
		"screen-a": { chatUuid: "chat-1", messages: a },
		"screen-b": { chatUuid: "chat-2", messages: b }
	}

	it("returns the same reference when no page holds the message", () => {
		expect(withPatchedOlderMessage(prev, "missing", "delete")).toBe(prev)
		expect(withPatchedOlderMessage(prev, "missing", m => m)).toBe(prev)
	})

	it("deletes from the holding page and keeps untouched pages by reference", () => {
		const next = withPatchedOlderMessage(prev, "m1", "delete")

		expect(next).not.toBe(prev)
		expect(next["screen-a"]?.messages.map(m => m.inner.uuid)).toEqual(["m2"])
		expect(next["screen-a"]?.chatUuid).toBe("chat-1")
		expect(next["screen-b"]).toBe(prev["screen-b"])
	})

	it("maps only the matching message", () => {
		const next = withPatchedOlderMessage(prev, "m2", m => ({ ...m, embedDisabled: true }))

		expect(next["screen-a"]?.messages[0]).toBe(a[0])
		expect(next["screen-a"]?.messages[1]?.embedDisabled).toBe(true)
	})

	it("patches every page holding the message", () => {
		const shared = message("m1")
		const both: OlderChatMessages = {
			"screen-a": { chatUuid: "chat-1", messages: [shared] },
			"screen-c": { chatUuid: "chat-1", messages: [shared, message("m9")] }
		}
		const next = withPatchedOlderMessage(both, "m1", "delete")

		expect(next["screen-a"]?.messages).toEqual([])
		expect(next["screen-c"]?.messages.map(m => m.inner.uuid)).toEqual(["m9"])
	})
})

describe("olderMessagesChatUuid", () => {
	it("finds the chat of the page holding the message", () => {
		const prev: OlderChatMessages = { "screen-a": { chatUuid: "chat-1", messages: [message("m1")] } }

		expect(olderMessagesChatUuid(prev, "m1")).toBe("chat-1")
		expect(olderMessagesChatUuid(prev, "m2")).toBeUndefined()
	})
})

describe("useChatsStore older pages", () => {
	beforeEach(() => {
		useChatsStore.setState({ olderMessages: {} })
	})

	it("appends pages per mount instance and clears only that instance", () => {
		const store = useChatsStore.getState()

		store.appendOlderMessages("screen-a", "chat-1", [message("m1")])
		store.appendOlderMessages("screen-a", "chat-1", [message("m2")])
		store.appendOlderMessages("screen-b", "chat-1", [message("m1")])

		expect(useChatsStore.getState().olderMessages["screen-a"]?.messages.map(m => m.inner.uuid)).toEqual(["m1", "m2"])

		store.clearOlderMessages("screen-a")

		expect(useChatsStore.getState().olderMessages["screen-a"]).toBeUndefined()
		expect(useChatsStore.getState().olderMessages["screen-b"]?.messages).toHaveLength(1)
	})

	it("does not notify subscribers when a patch or clear matches nothing", () => {
		useChatsStore.getState().appendOlderMessages("screen-a", "chat-1", [message("m1")])

		const listener = vi.fn()
		const unsubscribe = useChatsStore.subscribe(listener)

		useChatsStore.getState().patchOlderMessage("missing", "delete")
		useChatsStore.getState().clearOlderMessages("missing")

		expect(listener).not.toHaveBeenCalled()

		unsubscribe()
	})
})
