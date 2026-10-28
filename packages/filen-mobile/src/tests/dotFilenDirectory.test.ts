import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockSdkClient } = vi.hoisted(() => ({
	mockSdkClient: {
		findDirUuid: vi.fn(),
		getDir: vi.fn(),
		createDir: vi.fn(),
		updateDirMetadata: vi.fn(),
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
		CreatedTime: { Keep: { new: () => "keep" } },
		DirMeta_Tags: { Decoded: "Decoded" }
	}
})

import { ensureDotFilenSubdirectory, clearDotFilenDirectoryMemo } from "@/lib/dotFilenDirectory"
import { getKnownDotFilenUuid, isKnownDotFilenDir } from "@/lib/dotFilenKnown"
import { useSocketStore } from "@/stores/useSocket.store"
import events from "@/lib/events"

function dir(name: string) {
	return { uuid: `${name}-uuid`, meta: { tag: "Decoded", inner: [{ name }] } }
}

const dotFilen = dir(".filen")
const playlists = dir("playlists")
const chats = dir("chat-uploads")
const existing = [dotFilen, playlists, chats]

// The drive as the name-hash lookup sees it: `.filen` under the root, both subdirectories under `.filen`.
function serveExisting(): void {
	mockSdkClient.findDirUuid.mockImplementation(async (parent: string, name: string) => {
		const lower = name.toLowerCase()

		if (parent === "root-uuid") {
			return lower === ".filen" ? dotFilen.uuid : undefined
		}

		return parent === dotFilen.uuid ? existing.find(d => d.meta.inner[0]?.name.toLowerCase() === lower)?.uuid : undefined
	})
	mockSdkClient.getDir.mockImplementation(async (uuid: string) => existing.find(d => d.uuid === uuid))
}

function resetClient(): void {
	mockSdkClient.findDirUuid.mockReset()
	mockSdkClient.getDir.mockReset()
	mockSdkClient.createDir.mockReset()
	mockSdkClient.updateDirMetadata.mockReset()
}

describe("ensureDotFilenSubdirectory", () => {
	beforeEach(() => {
		clearDotFilenDirectoryMemo()
		useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
		resetClient()
	})

	it("finds existing directories by name and fetches only the subdirectory, listing nothing", async () => {
		serveExisting()

		const signal = new AbortController().signal

		await expect(ensureDotFilenSubdirectory("playlists", signal)).resolves.toBe(playlists)
		expect(mockSdkClient.findDirUuid).toHaveBeenNthCalledWith(1, "root-uuid", ".filen", { signal })
		expect(mockSdkClient.findDirUuid).toHaveBeenNthCalledWith(2, dotFilen.uuid, "playlists", { signal })
		expect(mockSdkClient.getDir).toHaveBeenCalledTimes(1)
		expect(mockSdkClient.getDir).toHaveBeenCalledWith(playlists.uuid, { signal })
		expect(mockSdkClient.createDir).not.toHaveBeenCalled()
	})

	it("creates both levels when .filen is missing, without looking under the new directory", async () => {
		const createdChild = dir("chat-uploads")

		mockSdkClient.findDirUuid.mockResolvedValueOnce(undefined)
		mockSdkClient.createDir.mockResolvedValueOnce(dotFilen)
		mockSdkClient.createDir.mockResolvedValueOnce(createdChild)

		await expect(ensureDotFilenSubdirectory("chat-uploads")).resolves.toBe(createdChild)
		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(1)
		expect(mockSdkClient.getDir).not.toHaveBeenCalled()
		expect(mockSdkClient.createDir).toHaveBeenNthCalledWith(1, { inner: { uuid: "root-uuid" } }, ".filen", undefined)
		expect(mockSdkClient.createDir).toHaveBeenNthCalledWith(2, { inner: dotFilen }, "chat-uploads", undefined)
	})

	it("fetches .filen to create a missing subdirectory in it", async () => {
		const createdChild = dir("playlists")

		mockSdkClient.findDirUuid.mockResolvedValueOnce(dotFilen.uuid)
		mockSdkClient.findDirUuid.mockResolvedValueOnce(undefined)
		mockSdkClient.getDir.mockResolvedValueOnce(dotFilen)
		mockSdkClient.createDir.mockResolvedValueOnce(createdChild)

		await expect(ensureDotFilenSubdirectory("playlists")).resolves.toBe(createdChild)
		expect(mockSdkClient.getDir).toHaveBeenCalledWith(dotFilen.uuid, undefined)
		expect(mockSdkClient.createDir).toHaveBeenCalledTimes(1)
		expect(mockSdkClient.createDir).toHaveBeenCalledWith({ inner: dotFilen }, "playlists", undefined)
	})
})

describe("ensureDotFilenSubdirectory memo", () => {
	function connect(connectedAt: number): void {
		useSocketStore.setState({ state: "connected", connectedAt })
	}

	beforeEach(() => {
		clearDotFilenDirectoryMemo()
		useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
		resetClient()
		serveExisting()
	})

	it("reuses each resolved directory within the same connected socket session", async () => {
		connect(100)

		await expect(ensureDotFilenSubdirectory("playlists")).resolves.toBe(playlists)
		await expect(ensureDotFilenSubdirectory("playlists")).resolves.toBe(playlists)
		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(2)

		await expect(ensureDotFilenSubdirectory("chat-uploads")).resolves.toBe(chats)
		await expect(ensureDotFilenSubdirectory("chat-uploads")).resolves.toBe(chats)
		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(4)
	})

	it("looks up every time while the socket is not connected", async () => {
		await ensureDotFilenSubdirectory("playlists")
		await ensureDotFilenSubdirectory("playlists")

		useSocketStore.setState({ state: "reconnecting", connectedAt: 100 })

		await ensureDotFilenSubdirectory("playlists")

		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(6)
	})

	it("looks up again once the socket reconnected", async () => {
		connect(100)

		await ensureDotFilenSubdirectory("playlists")

		connect(200)

		await ensureDotFilenSubdirectory("playlists")
		await ensureDotFilenSubdirectory("playlists")

		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(4)
	})

	it("keeps nothing a clear overlapped", async () => {
		connect(100)

		let release: () => void = () => {}
		const gate = new Promise<void>(resolve => {
			release = resolve
		})

		mockSdkClient.findDirUuid.mockImplementationOnce(async () => {
			await gate

			return dotFilen.uuid
		})

		const pending = ensureDotFilenSubdirectory("playlists")

		clearDotFilenDirectoryMemo()
		release()

		await expect(pending).resolves.toBe(playlists)

		await ensureDotFilenSubdirectory("playlists")

		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(4)
	})

	it("keeps nothing resolved across a connect: what changed while down was missed", async () => {
		useSocketStore.setState({ state: "disconnected", connectedAt: 100 })
		mockSdkClient.findDirUuid.mockImplementationOnce(async () => {
			connect(300)

			return dotFilen.uuid
		})

		await ensureDotFilenSubdirectory("playlists")
		await ensureDotFilenSubdirectory("playlists")

		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(4)
	})

	it("local drive changes and logout clear it", async () => {
		connect(100)

		await ensureDotFilenSubdirectory("playlists")

		events.emit("driveItemRemoved", { uuid: "x" })
		await ensureDotFilenSubdirectory("playlists")

		events.emit("driveItemUpdated", { previousUuid: "x", item: playlists as never })
		await ensureDotFilenSubdirectory("playlists")

		events.emit("logout")
		await ensureDotFilenSubdirectory("playlists")

		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(8)
	})
})

describe("ensureDotFilenSubdirectory canonical names", () => {
	beforeEach(() => {
		clearDotFilenDirectoryMemo()
		useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
		resetClient()
	})

	function serve(subdirs: ReturnType<typeof dir>[]): void {
		mockSdkClient.findDirUuid.mockImplementation(async (parent: string, name: string) => {
			if (parent === "root-uuid") {
				return name.toLowerCase() === ".filen" ? dotFilen.uuid : undefined
			}

			return subdirs.find(d => d.meta.inner[0]?.name.toLowerCase() === name.toLowerCase())?.uuid
		})
		mockSdkClient.getDir.mockImplementation(async (uuid: string) => [dotFilen, ...subdirs].find(d => d.uuid === uuid))
	}

	it("renames a subdirectory found under another case to its canonical name", async () => {
		const legacy = dir("Playlists")
		const renamed = dir("playlists")

		serve([legacy])
		mockSdkClient.updateDirMetadata.mockResolvedValueOnce(renamed)

		await expect(ensureDotFilenSubdirectory("playlists")).resolves.toBe(renamed)
		expect(mockSdkClient.updateDirMetadata).toHaveBeenCalledExactlyOnceWith(legacy, { name: "playlists", created: "keep" }, undefined)
	})

	it("leaves a canonical subdirectory alone", async () => {
		const canonical = dir("playlists")

		serve([canonical])

		await expect(ensureDotFilenSubdirectory("playlists")).resolves.toBe(canonical)
		expect(mockSdkClient.updateDirMetadata).not.toHaveBeenCalled()
	})

	it("still uses the directory when the rename fails", async () => {
		const legacy = dir("Playlists")

		serve([legacy])
		mockSdkClient.updateDirMetadata.mockRejectedValueOnce(new Error("offline"))

		await expect(ensureDotFilenSubdirectory("playlists")).resolves.toBe(legacy)
	})

	it("finds the legacy Chat Uploads when chat-uploads is missing, renames it and creates nothing", async () => {
		const legacy = dir("Chat Uploads")
		const renamed = dir("chat-uploads")

		serve([legacy])
		mockSdkClient.updateDirMetadata.mockResolvedValueOnce(renamed)

		await expect(ensureDotFilenSubdirectory("chat-uploads")).resolves.toBe(renamed)
		expect(mockSdkClient.findDirUuid).toHaveBeenNthCalledWith(2, dotFilen.uuid, "chat-uploads", undefined)
		expect(mockSdkClient.findDirUuid).toHaveBeenNthCalledWith(3, dotFilen.uuid, "Chat Uploads", undefined)
		expect(mockSdkClient.createDir).not.toHaveBeenCalled()
	})

	it("prefers chat-uploads over a legacy Chat Uploads beside it, leaving the legacy one alone", async () => {
		const canonical = dir("chat-uploads")
		const legacy = { ...dir("Chat Uploads"), uuid: "legacy-uuid" }

		serve([legacy, canonical])
		mockSdkClient.findDirUuid.mockImplementation(async (parent: string, name: string) =>
			parent === "root-uuid" ? dotFilen.uuid : name === "chat-uploads" ? canonical.uuid : legacy.uuid
		)

		await expect(ensureDotFilenSubdirectory("chat-uploads")).resolves.toBe(canonical)
		expect(mockSdkClient.findDirUuid).toHaveBeenCalledTimes(2)
		expect(mockSdkClient.updateDirMetadata).not.toHaveBeenCalled()
	})
})

describe("known .filen directories", () => {
	beforeEach(() => {
		// Known directories outlive the memo by design; earlier tests' resolves are forgotten as a logout would.
		events.emit("logout")
		clearDotFilenDirectoryMemo()
		useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
		resetClient()
		serveExisting()
	})

	it("remembers what a resolve learned past a memo clear, and forgets it on logout", async () => {
		await ensureDotFilenSubdirectory("playlists")
		clearDotFilenDirectoryMemo()

		expect(getKnownDotFilenUuid()).toBe(dotFilen.uuid)
		expect(isKnownDotFilenDir(dotFilen.uuid)).toBe(true)
		expect(isKnownDotFilenDir(playlists.uuid)).toBe(true)
		expect(isKnownDotFilenDir(chats.uuid)).toBe(false)

		events.emit("logout")

		expect(getKnownDotFilenUuid()).toBeNull()
		expect(isKnownDotFilenDir(playlists.uuid)).toBe(false)
	})
})
