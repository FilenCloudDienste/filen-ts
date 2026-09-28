import { describe, expect, it, vi } from "vitest"
import { wipeThumbnailStore } from "@/features/drive/lib/thumbCache"

function lockedError(): DOMException {
	return new DOMException("entry is locked", "NoModificationAllowedError")
}

function notFound(): DOMException {
	return new DOMException("no such entry", "NotFoundError")
}

function fakeRoot(removeEntry: (name: string, options?: FileSystemRemoveOptions) => Promise<void>): Promise<FileSystemDirectoryHandle> {
	return Promise.resolve({ removeEntry } as unknown as FileSystemDirectoryHandle)
}

describe("wipeThumbnailStore", () => {
	it("removes the whole thumbnail tree recursively, sweeping twice for a write that lands mid-wipe", async () => {
		const removeEntry = vi.fn<(name: string, options?: FileSystemRemoveOptions) => Promise<void>>(() => Promise.resolve())

		await wipeThumbnailStore(fakeRoot(removeEntry))

		expect(removeEntry).toHaveBeenCalledTimes(2)
		expect(removeEntry).toHaveBeenNthCalledWith(1, "thumbnails", { recursive: true })
	})

	it("treats an already-missing tree as wiped", async () => {
		const removeEntry = vi.fn(() => Promise.reject(notFound()))

		await expect(wipeThumbnailStore(fakeRoot(removeEntry))).resolves.toBeUndefined()
	})

	it("succeeds when only the first sweep hit a file an in-flight write held open", async () => {
		const removeEntry = vi.fn<() => Promise<void>>().mockRejectedValueOnce(lockedError()).mockResolvedValueOnce(undefined)

		await expect(wipeThumbnailStore(fakeRoot(removeEntry))).resolves.toBeUndefined()
		expect(removeEntry).toHaveBeenCalledTimes(2)
	})

	it("reports a failure that survives both sweeps", async () => {
		const removeEntry = vi.fn(() => Promise.reject(lockedError()))

		await expect(wipeThumbnailStore(fakeRoot(removeEntry))).rejects.toThrow("entry is locked")
	})
})
