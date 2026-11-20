import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockGetDocumentAsync } = vi.hoisted(() => ({
	mockGetDocumentAsync: vi.fn()
}))

vi.mock("expo-document-picker", () => ({ getDocumentAsync: mockGetDocumentAsync }))
vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@/lib/systemPresentation", () => ({
	withSystemPresentation: vi.fn(async (fn: () => Promise<unknown>) => await fn())
}))


const INBOX = "file:///tmp/io.filen.app-Inbox"
const PICKS = "file:///cache/filen-tmp/document-picks"


function asset(uri: string, name: string) {
	return {
		uri,
		name,
		mimeType: "application/octet-stream",
		size: 3,
		lastModified: 1234
	}
}

// Every test starts from a fresh module registry: COPY_TO_CACHE_DIRECTORY reads Platform.OS at module
// load, and the once-per-process pick sweep keeps module state. Everything is then imported from that
// same registry, so the in-memory fs and Platform are the instances the unit under test sees.
async function load(os: "ios" | "android" = "ios") {
	vi.resetModules()

	const { Platform } = await import("react-native")

	Platform.OS = os

	const { fs } = await import("@/tests/mocks/expoFileSystem")
	const { resetUUIDCounter } = await import("@/tests/mocks/expoCrypto")
	const { File } = await import("expo-file-system")

	fs.clear()
	resetUUIDCounter()

	return {
		...(await import("@/lib/documentPicker")),
		...(await import("@/lib/tmp")),
		fs,
		File,
		seed: (uri: string, bytes: number[]) => new File(uri).writeSync(new Uint8Array(bytes)),
		filesUnder: (prefix: string) =>
			[...fs.entries()].filter(([uri, entry]) => uri.startsWith(`${prefix}/`) && entry instanceof Uint8Array).map(([uri]) => uri)
	}
}

beforeEach(() => {
	mockGetDocumentAsync.mockReset()
})

describe("pickDocuments", () => {
	it("moves iOS Inbox picks into filen-tmp/document-picks and leaves the Inbox empty", async () => {
		const { pickDocuments, File, seed, filesUnder } = await load("ios")

		seed(`${INBOX}/a.txt`, [1, 2, 3])
		seed(`${INBOX}/b.heic`, [4, 5, 6])

		mockGetDocumentAsync.mockResolvedValue({
			canceled: false,
			assets: [asset(`${INBOX}/a.txt`, "a.txt"), asset(`${INBOX}/b.heic`, "b.heic")]
		})

		const result = await pickDocuments({ type: "*/*", multiple: true })

		expect(mockGetDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: false }))
		expect(result.canceled).toBe(false)

		const documents = result.documents ?? []

		expect(documents).toHaveLength(2)
		expect(filesUnder(INBOX)).toEqual([])

		for (const [index, document] of documents.entries()) {
			expect(document.uri.startsWith(`${PICKS}/`)).toBe(true)
			expect(new File(document.uri).exists).toBe(true)
			// Name, size, mime and mtime still come from the picker; only the location changes.
			expect(document.name).toBe(index === 0 ? "a.txt" : "b.heic")
			expect(document.size).toBe(3)
			expect(document.lastModified).toBe(1234)
		}

		// The source extension survives (drive upload's HEIC check reads the URI).
		expect(documents[0]?.uri.endsWith(".txt")).toBe(true)
		expect(documents[1]?.uri.endsWith(".heic")).toBe(true)
		expect(new File(documents[1]?.uri ?? "").bytesSync()).toEqual(new Uint8Array([4, 5, 6]))
	})

	it("gives every staged pick a unique name, so a same-named second pick cannot overwrite the first", async () => {
		const { pickDocuments, File, seed } = await load("ios")

		seed(`${INBOX}/same.txt`, [1])
		mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset(`${INBOX}/same.txt`, "same.txt")] })

		const first = await pickDocuments({ type: "*/*", multiple: false })

		seed(`${INBOX}/same.txt`, [2])

		const second = await pickDocuments({ type: "*/*", multiple: false })

		const firstUri = first.documents?.[0]?.uri ?? ""
		const secondUri = second.documents?.[0]?.uri ?? ""

		expect(firstUri).not.toBe(secondUri)
		expect(new File(firstUri).bytesSync()).toEqual(new Uint8Array([1]))
		expect(new File(secondUri).bytesSync()).toEqual(new Uint8Array([2]))
	})

	it("stages Android cache copies too, keeping copyToCacheDirectory on", async () => {
		const { pickDocuments, File, seed } = await load("android")

		seed("file:///cache/DocumentPicker/x.pdf", [9])
		mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset("file:///cache/DocumentPicker/x.pdf", "x.pdf")] })

		const result = await pickDocuments({ type: "*/*", multiple: false })

		expect(mockGetDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: true }))
		expect(result.documents?.[0]?.uri.startsWith(`${PICKS}/`)).toBe(true)
		expect(new File("file:///cache/DocumentPicker/x.pdf").exists).toBe(false)
	})

	it("returns canceled without touching the filesystem", async () => {
		const { pickDocuments, fs } = await load("ios")

		mockGetDocumentAsync.mockResolvedValue({ canceled: true, assets: null })

		expect(await pickDocuments({ type: "*/*", multiple: true })).toEqual({ canceled: true, documents: null })
		expect(fs.size).toBe(0)
	})

	it("rolls back the whole batch when one move fails", async () => {
		const { pickDocuments, seed, filesUnder } = await load("ios")

		seed(`${INBOX}/a.txt`, [1])
		seed(`${INBOX}/c.txt`, [3])

		// b.txt was never written, so its move throws after a.txt has already been staged.
		mockGetDocumentAsync.mockResolvedValue({
			canceled: false,
			assets: [asset(`${INBOX}/a.txt`, "a.txt"), asset(`${INBOX}/b.txt`, "b.txt"), asset(`${INBOX}/c.txt`, "c.txt")]
		})

		await expect(pickDocuments({ type: "*/*", multiple: true })).rejects.toThrow()

		expect(filesUnder(PICKS)).toEqual([])
		expect(filesUnder(INBOX)).toEqual([])
	})

	it("rejects duplicate picker URIs before staging and deletes them", async () => {
		const { pickDocuments, seed, filesUnder } = await load("ios")

		seed(`${INBOX}/dup.txt`, [1])
		mockGetDocumentAsync.mockResolvedValue({
			canceled: false,
			assets: [asset(`${INBOX}/dup.txt`, "dup.txt"), asset(`${INBOX}/dup.txt`, "dup.txt")]
		})

		await expect(pickDocuments({ type: "*/*", multiple: true })).rejects.toThrow("duplicate")

		expect(filesUnder(PICKS)).toEqual([])
		expect(filesUnder(INBOX)).toEqual([])
	})
})

describe("sweepOrphanedPicks", () => {
	it("deletes leftover picks on the first call of a process only", async () => {
		const { newTmpPickFile, sweepOrphanedPicks } = await load()

		const orphan = newTmpPickFile(".bin")

		orphan.writeSync(new Uint8Array([1]))

		sweepOrphanedPicks()

		expect(orphan.exists).toBe(false)

		// A pick made after the first sweep is in flight; later setup() runs must not touch it.
		const live = newTmpPickFile(".bin")

		live.writeSync(new Uint8Array([2]))

		sweepOrphanedPicks()

		expect(live.exists).toBe(true)
	})

	it("is a no-op when nothing was ever picked", async () => {
		const { sweepOrphanedPicks, fs } = await load()

		expect(() => sweepOrphanedPicks()).not.toThrow()
		expect(fs.size).toBe(0)
	})
})
