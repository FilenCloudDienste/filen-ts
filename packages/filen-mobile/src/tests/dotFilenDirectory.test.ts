import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSdkClient } = vi.hoisted(() => ({
	mockSdkClient: {
		listDir: vi.fn(),
		createDir: vi.fn(),
		root: vi.fn(() => ({ uuid: "root-uuid" }))
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: vi.fn(async () => ({ authedSdkClient: mockSdkClient }))
	}
}))

vi.mock("@/lib/signals", () => ({
	toSignalOpts: (signal?: AbortSignal) => (signal ? { signal } : undefined)
}))

vi.mock("@filen/sdk-rs", () => {
	class WrapClass {
		public inner: unknown

		public constructor(inner: unknown) {
			this.inner = inner
		}
	}

	return {
		AnyNormalDir: { Root: WrapClass, Dir: WrapClass },
		DirMeta_Tags: { Decoded: "Decoded", Encrypted: "Encrypted" }
	}
})

import { ensureDotFilenSubdirectory, clearDotFilenDirectoryMemo } from "@/lib/dotFilenDirectory"
import { useSocketStore } from "@/stores/useSocket.store"
import events from "@/lib/events"

function dir(name: string, tag = "Decoded") {
	return { uuid: `${name}-uuid`, meta: { tag, inner: [{ name }] } }
}

describe("ensureDotFilenSubdirectory", () => {
	beforeEach(() => {
		clearDotFilenDirectoryMemo()
		useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
		mockSdkClient.listDir.mockReset()
		mockSdkClient.createDir.mockReset()
	})

	it("reuses existing directories matched case-insensitively without creating", async () => {
		const dotFilen = dir(" .FILEN ")
		const playlists = dir("playlists")

		mockSdkClient.listDir.mockResolvedValueOnce({ dirs: [dir("other"), dotFilen], files: [] })
		mockSdkClient.listDir.mockResolvedValueOnce({ dirs: [playlists], files: [] })

		const signal = new AbortController().signal

		await expect(ensureDotFilenSubdirectory("Playlists", signal)).resolves.toBe(playlists)
		expect(mockSdkClient.listDir).toHaveBeenNthCalledWith(1, { inner: { uuid: "root-uuid" } }, { signal })
		expect(mockSdkClient.listDir).toHaveBeenNthCalledWith(2, { inner: dotFilen }, { signal })
		expect(mockSdkClient.createDir).not.toHaveBeenCalled()
	})

	it("creates missing directories, ignoring undecryptable name matches", async () => {
		const createdDotFilen = dir(".filen")
		const createdChild = dir("Chat Uploads")

		mockSdkClient.listDir.mockResolvedValueOnce({ dirs: [dir(".filen", "Encrypted")], files: [] })
		mockSdkClient.listDir.mockResolvedValueOnce({ dirs: [], files: [] })
		mockSdkClient.createDir.mockResolvedValueOnce(createdDotFilen)
		mockSdkClient.createDir.mockResolvedValueOnce(createdChild)

		await expect(ensureDotFilenSubdirectory("Chat Uploads")).resolves.toBe(createdChild)
		expect(mockSdkClient.createDir).toHaveBeenNthCalledWith(1, { inner: { uuid: "root-uuid" } }, ".filen", undefined)
		expect(mockSdkClient.createDir).toHaveBeenNthCalledWith(2, { inner: createdDotFilen }, "Chat Uploads", undefined)
	})
})

describe("ensureDotFilenSubdirectory memo", () => {
	type Parent = { inner: { uuid: string } }

	const dotFilen = dir(" .FILEN ")
	const playlists = dir("Playlists")
	const chats = dir("Chat Uploads")

	function listing(parent: Parent) {
		return { dirs: parent.inner.uuid === "root-uuid" ? [dir("other"), dotFilen] : [chats, playlists], files: [] }
	}

	function connect(connectedAt: number): void {
		useSocketStore.setState({ state: "connected", connectedAt })
	}

	beforeEach(() => {
		clearDotFilenDirectoryMemo()
		useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
		mockSdkClient.listDir.mockReset().mockImplementation(async (parent: Parent) => listing(parent))
		mockSdkClient.createDir.mockReset()
	})

	it("reuses each resolved directory within the same connected socket session", async () => {
		connect(100)

		await expect(ensureDotFilenSubdirectory("Playlists")).resolves.toBe(playlists)
		await expect(ensureDotFilenSubdirectory("Playlists")).resolves.toBe(playlists)
		expect(mockSdkClient.listDir).toHaveBeenCalledTimes(2)

		await expect(ensureDotFilenSubdirectory("Chat Uploads")).resolves.toBe(chats)
		await expect(ensureDotFilenSubdirectory("Chat Uploads")).resolves.toBe(chats)
		expect(mockSdkClient.listDir).toHaveBeenCalledTimes(4)
	})

	it("lists every time while the socket is not connected", async () => {
		await ensureDotFilenSubdirectory("Playlists")
		await ensureDotFilenSubdirectory("Playlists")

		useSocketStore.setState({ state: "reconnecting", connectedAt: 100 })

		await ensureDotFilenSubdirectory("Playlists")

		expect(mockSdkClient.listDir).toHaveBeenCalledTimes(6)
	})

	it("lists again once the socket reconnected", async () => {
		connect(100)

		await ensureDotFilenSubdirectory("Playlists")

		connect(200)

		await ensureDotFilenSubdirectory("Playlists")
		await ensureDotFilenSubdirectory("Playlists")

		expect(mockSdkClient.listDir).toHaveBeenCalledTimes(4)
	})

	it("keeps nothing a clear overlapped", async () => {
		connect(100)

		let release: () => void = () => {}
		const gate = new Promise<void>(resolve => {
			release = resolve
		})

		mockSdkClient.listDir.mockImplementationOnce(async (parent: Parent) => {
			await gate

			return listing(parent)
		})

		const pending = ensureDotFilenSubdirectory("Playlists")

		clearDotFilenDirectoryMemo()
		release()

		await expect(pending).resolves.toBe(playlists)

		await ensureDotFilenSubdirectory("Playlists")

		expect(mockSdkClient.listDir).toHaveBeenCalledTimes(4)
	})

	it("keeps nothing resolved across a connect: what changed while down was missed", async () => {
		useSocketStore.setState({ state: "disconnected", connectedAt: 100 })
		mockSdkClient.listDir.mockImplementationOnce(async (parent: Parent) => {
			connect(300)

			return listing(parent)
		})

		await ensureDotFilenSubdirectory("Playlists")
		await ensureDotFilenSubdirectory("Playlists")

		expect(mockSdkClient.listDir).toHaveBeenCalledTimes(4)
	})

	it("local drive changes and logout clear it", async () => {
		connect(100)

		await ensureDotFilenSubdirectory("Playlists")

		events.emit("driveItemRemoved", { uuid: "x" })
		await ensureDotFilenSubdirectory("Playlists")

		events.emit("driveItemUpdated", { previousUuid: "x", item: playlists as never })
		await ensureDotFilenSubdirectory("Playlists")

		events.emit("logout")
		await ensureDotFilenSubdirectory("Playlists")

		expect(mockSdkClient.listDir).toHaveBeenCalledTimes(8)
	})
})
