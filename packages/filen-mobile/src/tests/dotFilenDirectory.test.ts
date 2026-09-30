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

import { ensureDotFilenSubdirectory } from "@/lib/dotFilenDirectory"

function dir(name: string, tag = "Decoded") {
	return { uuid: `${name}-uuid`, meta: { tag, inner: [{ name }] } }
}

describe("ensureDotFilenSubdirectory", () => {
	beforeEach(() => {
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
