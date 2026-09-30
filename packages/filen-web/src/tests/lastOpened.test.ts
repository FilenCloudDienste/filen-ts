import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { kvStore, kvGetJson, kvSetJson } = vi.hoisted(() => {
	const kvStore = new Map<string, unknown>()

	return {
		kvStore,
		kvGetJson: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
		kvSetJson: vi.fn((key: string, value: unknown) => {
			kvStore.set(key, value)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson }))

// The session mirror is module state, so every test gets a fresh module.
async function freshModule() {
	vi.resetModules()

	return import("@/features/shell/lib/lastOpened")
}

beforeEach(() => {
	kvStore.clear()
})

afterEach(() => {
	vi.clearAllMocks()
})

describe("lastOpened", () => {
	it("reads null when nothing is stored", async () => {
		const { peekLastOpened, readLastOpened } = await freshModule()

		expect(peekLastOpened("chats")).toBeUndefined()
		expect(await readLastOpened("chats")).toBeNull()
		expect(peekLastOpened("chats")).toBeNull()
	})

	it("persists per module under versioned keys and reads back after a reload", async () => {
		const first = await freshModule()

		first.rememberLastOpened("chats", "chat-a")
		first.rememberLastOpened("notes", "note-a")
		await vi.waitFor(() => {
			expect(kvStore.get("shell.lastOpened.chats.v1")).toBe("chat-a")
			expect(kvStore.get("shell.lastOpened.notes.v1")).toBe("note-a")
		})

		const reloaded = await freshModule()

		expect(await reloaded.readLastOpened("chats")).toBe("chat-a")
		expect(await reloaded.readLastOpened("notes")).toBe("note-a")
	})

	it("skips the write when the uuid is unchanged", async () => {
		const { rememberLastOpened, peekLastOpened } = await freshModule()

		rememberLastOpened("notes", "note-a")
		rememberLastOpened("notes", "note-a")
		rememberLastOpened("notes", "note-b")

		expect(kvSetJson).toHaveBeenCalledTimes(2)
		expect(peekLastOpened("notes")).toBe("note-b")
	})

	it("reads the kv once per session", async () => {
		kvStore.set("shell.lastOpened.chats.v1", "chat-a")
		const { readLastOpened } = await freshModule()

		await Promise.all([readLastOpened("chats"), readLastOpened("chats")])
		await readLastOpened("chats")

		expect(kvGetJson).toHaveBeenCalledTimes(1)
	})

	it("keeps a write that lands while the first read is in flight", async () => {
		kvStore.set("shell.lastOpened.chats.v1", "chat-old")
		const { readLastOpened, rememberLastOpened, peekLastOpened } = await freshModule()

		const read = readLastOpened("chats")
		rememberLastOpened("chats", "chat-new")

		expect(await read).toBe("chat-new")
		expect(peekLastOpened("chats")).toBe("chat-new")
	})

	it("reads null when storage fails", async () => {
		kvGetJson.mockRejectedValueOnce(new Error("no db leader"))
		const { readLastOpened } = await freshModule()

		expect(await readLastOpened("notes")).toBeNull()
	})
})
