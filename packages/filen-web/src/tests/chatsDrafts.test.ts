import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The per-chat draft's disk mirror: a value already on disk is never written back, a changed one is
// written once after the debounce, and a delete runs at once and cancels a pending write.

const { kvGetJson, kvSetJson, kvDelete } = vi.hoisted(() => ({
	kvGetJson: vi.fn<(key: string) => Promise<unknown>>(),
	kvSetJson: vi.fn<(key: string, value: unknown) => Promise<void>>(),
	kvDelete: vi.fn<(key: string) => Promise<void>>()
}))

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson, kvDelete }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn() } }))

import { deleteDraft, loadDraft, saveDraftDebounced } from "@/features/chats/lib/drafts"
import { testUuid } from "@/tests/support/uuid"

const DEBOUNCE_MS = 400

// The module keeps per-chat state for the whole file, so every case uses its own chat.
let chatSeq = 0

function nextChat(): string {
	chatSeq += 1

	return testUuid(`draft${String(chatSeq)}`)
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	kvGetJson.mockReset()
	kvSetJson.mockReset().mockResolvedValue(undefined)
	kvDelete.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("saveDraftDebounced", () => {
	it("schedules no write for the value just read from disk", async () => {
		const chat = nextChat()
		kvGetJson.mockResolvedValue("x")

		expect(await loadDraft(chat)).toBe("x")

		saveDraftDebounced(chat, "x")
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvSetJson).not.toHaveBeenCalled()
		expect(kvDelete).not.toHaveBeenCalled()
	})

	it("schedules no delete for an empty draft with nothing on disk", async () => {
		const chat = nextChat()
		kvGetJson.mockResolvedValue(null)

		await loadDraft(chat)

		saveDraftDebounced(chat, "")
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvDelete).not.toHaveBeenCalled()
	})

	it("schedules no delete when the empty mirror runs before the chat's first read settles", async () => {
		const chat = nextChat()
		let resolveRead: (value: unknown) => void = () => undefined
		kvGetJson.mockReturnValue(
			new Promise(r => {
				resolveRead = r
			})
		)

		const read = loadDraft(chat)
		saveDraftDebounced(chat, "")
		resolveRead(null)
		await read
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvDelete).not.toHaveBeenCalled()
	})

	it("adds no second delete when the empty mirror runs while a delete is in flight", async () => {
		const chat = nextChat()
		let resolveDelete: () => void = () => undefined
		kvDelete.mockReturnValueOnce(
			new Promise<void>(r => {
				resolveDelete = r
			})
		)

		const deleting = deleteDraft(chat)
		saveDraftDebounced(chat, "")
		resolveDelete()
		await deleting
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvDelete).toHaveBeenCalledTimes(1)
	})

	it("writes a changed value once after the debounce, then not again", async () => {
		const chat = nextChat()
		kvGetJson.mockResolvedValue("x")
		await loadDraft(chat)

		saveDraftDebounced(chat, "xy")
		saveDraftDebounced(chat, "xyz")
		vi.advanceTimersByTime(DEBOUNCE_MS - 1)

		expect(kvSetJson).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		await flush()

		expect(kvSetJson).toHaveBeenCalledTimes(1)
		expect(kvSetJson).toHaveBeenCalledWith(`chatDraft:${chat}`, "xyz")

		saveDraftDebounced(chat, "xyz")
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvSetJson).toHaveBeenCalledTimes(1)
	})

	it("drops a pending write when the value returns to what is on disk", async () => {
		const chat = nextChat()
		kvGetJson.mockResolvedValue("x")
		await loadDraft(chat)

		saveDraftDebounced(chat, "xy")
		saveDraftDebounced(chat, "x")
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvSetJson).not.toHaveBeenCalled()
	})

	it("writes as before when nothing is known about the chat's disk state", async () => {
		const chat = nextChat()

		saveDraftDebounced(chat, "")
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvDelete).toHaveBeenCalledWith(`chatDraft:${chat}`)
	})
	it("keeps a pending write per chat, so switching chats within the debounce loses neither", async () => {
		const first = nextChat()
		const second = nextChat()

		saveDraftDebounced(first, "one")
		saveDraftDebounced(second, "two")
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvSetJson).toHaveBeenCalledTimes(2)
		expect(kvSetJson).toHaveBeenCalledWith(`chatDraft:${first}`, "one")
		expect(kvSetJson).toHaveBeenCalledWith(`chatDraft:${second}`, "two")
	})
})

describe("loadDraft", () => {
	it("reads an empty draft when the read fails", async () => {
		kvGetJson.mockRejectedValue(new Error("kv unavailable"))

		expect(await loadDraft(nextChat())).toBe("")
	})
})

describe("deleteDraft", () => {
	it("deletes immediately and cancels a pending write", async () => {
		const chat = nextChat()
		kvGetJson.mockResolvedValue("x")
		await loadDraft(chat)

		saveDraftDebounced(chat, "sent text")
		void deleteDraft(chat)

		expect(kvDelete).toHaveBeenCalledTimes(1)
		expect(kvDelete).toHaveBeenCalledWith(`chatDraft:${chat}`)

		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvSetJson).not.toHaveBeenCalled()
	})

	it("leaves the chat's draft known empty once done, so an empty mirror writes nothing", async () => {
		const chat = nextChat()

		await deleteDraft(chat)
		saveDraftDebounced(chat, "")
		vi.advanceTimersByTime(DEBOUNCE_MS)
		await flush()

		expect(kvDelete).toHaveBeenCalledTimes(1)
	})
})
