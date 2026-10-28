import { describe, expect, it, vi } from "vitest"
import type { File, SocketEvent } from "@filen/sdk-rs"
import {
	USER_DICTIONARY_FILE_NAME,
	parseUserDictionary,
	serializeUserDictionary,
	addUserWord,
	emptyUserDictionary
} from "@filen/spellcheck"
import { driveFile } from "@/tests/support/videoDrive"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/sdk/socket", () => ({ registerSocketHandler: () => () => undefined }))
vi.mock("@/lib/dotFilen", () => ({
	dotFilenSubdirUuid: () => null,
	findDotFilenSubdir: () => Promise.resolve(null),
	getDotFilenSubdir: () => Promise.resolve("office"),
	noteDotFilenFile: () => undefined,
	onDotFilenSubdirForgotten: () => () => undefined
}))

const { UserDictionaryStore } = await import("@/features/spellcheck/lib/userDictionary")

const OFFICE = "00000000-0000-4000-8000-0000000000f1"

type DriveEvent = Extract<SocketEvent, { type: "drive" }>

// A drive with `.filen/office` (once created) holding the dictionary file's versions.
function fakeDrive(initial?: string) {
	let dir: string | null = initial === undefined ? null : OFFICE
	let head: { file: File; text: string } | undefined
	let counter = 0
	const uploads: string[] = []
	const requests: string[] = []

	const put = (text: string): File => {
		const file = driveFile(OFFICE, USER_DICTIONARY_FILE_NAME, {
			uuid: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
			timestamp: counter,
			size: text.length
		})

		head = { file, text }

		return file
	}

	if (initial !== undefined) put(initial)

	const sdk = {
		officeDir: vi.fn(() => {
			requests.push("officeDir")
			dir = OFFICE

			return Promise.resolve(OFFICE)
		}),
		findOfficeDir: vi.fn(() => {
			requests.push("find")

			return Promise.resolve(dir)
		}),
		knownOfficeDir: () => dir,
		noteSystemFile: vi.fn(),
		listDirectory: vi.fn(() => {
			requests.push("list")

			return Promise.resolve(head === undefined ? [] : [head.file])
		}),
		download: vi.fn((file: File) => {
			requests.push("download")

			return Promise.resolve(new TextEncoder().encode(head?.file.uuid === file.uuid ? head.text : "{}"))
		}),
		upload: vi.fn((_parent: string, bytes: Uint8Array) => {
			requests.push("upload")

			const text = new TextDecoder().decode(bytes)

			uploads.push(text)

			return Promise.resolve(put(text))
		})
	}

	return {
		sdk,
		uploads,
		requests,
		// The socket event for the current file (this session's own upload echoing back).
		echo: (): DriveEvent => ({ type: "drive", inner: { type: "fileNew", file: head?.file } }) as unknown as DriveEvent,
		// Another device saves the file.
		saveElsewhere: (text: string): DriveEvent =>
			({ type: "drive", inner: { type: "fileNew", file: put(text) } }) as unknown as DriveEvent
	}
}

let clock = 1000
const now = () => ++clock

describe("UserDictionaryStore", () => {
	it("reads nothing into an empty list when the directory does not exist, and creates it on the first word", async () => {
		const drive = fakeDrive()
		const store = new UserDictionaryStore(drive.sdk, now)

		await store.load()
		expect(store.words()).toEqual([])
		expect(drive.requests).toEqual(["find"])

		await store.add("Filen")
		expect(store.words()).toEqual(["Filen"])
		expect(drive.requests).toEqual(["find", "officeDir", "upload"])
		expect(parseUserDictionary(drive.uploads[0] ?? "").words).toHaveProperty("Filen")
	})

	it("shows an addition at once and uploads it merged with the file as it stands", async () => {
		const remote = serializeUserDictionary(addUserWord(emptyUserDictionary(), "zorp", 5))
		const drive = fakeDrive(remote)
		const store = new UserDictionaryStore(drive.sdk, now)
		const seen: (readonly string[])[] = []

		store.subscribe(words => seen.push(words))

		const adding = store.add("Filen")

		expect(store.words()).toEqual(["Filen"])
		await adding
		expect(store.words()).toEqual(["Filen", "zorp"])
		expect(Object.keys(parseUserDictionary(drive.uploads.at(-1) ?? "").words).sort()).toEqual(["Filen", "zorp"])
		expect(seen).toEqual([["Filen"], ["Filen", "zorp"]])
	})

	it("uploads nothing when nothing changed and re-reads only after another session saved", async () => {
		const drive = fakeDrive(serializeUserDictionary(addUserWord(emptyUserDictionary(), "zorp", 5)))
		const store = new UserDictionaryStore(drive.sdk, now)

		await store.load()
		await store.load()
		await store.add("zorp")
		expect(drive.requests).toEqual(["find", "list", "download"])

		await store.add("Filen")
		expect(drive.requests).toEqual(["find", "list", "download", "upload"])

		// Its own upload echoing back does not count as a change.
		store.handleDriveEvent(drive.echo())
		await store.load()
		expect(drive.requests).toHaveLength(4)

		const event = drive.saveElsewhere(serializeUserDictionary(addUserWord(addUserWord(emptyUserDictionary(), "zorp", 5), "Quux", 9)))

		store.handleDriveEvent(event)
		await store.load()
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(store.words()).toEqual(["Filen", "Quux", "zorp"])
		expect(drive.requests.slice(4)).toEqual(["find", "list", "download", "upload"])
	})

	it("removes words with a tombstone that survives merges", async () => {
		const drive = fakeDrive(serializeUserDictionary(addUserWord(emptyUserDictionary(), "zorp", 5)))
		const store = new UserDictionaryStore(drive.sdk, now)

		await store.load()
		await store.remove("zorp")
		expect(store.words()).toEqual([])
		expect(parseUserDictionary(drive.uploads.at(-1) ?? "").removed).toHaveProperty("zorp")
	})

	it("never overwrites a file written by a newer format", async () => {
		const drive = fakeDrive('{"v":2,"words":{"a":1}}')
		const store = new UserDictionaryStore(drive.sdk, now)

		await store.add("Filen")
		expect(store.words()).toEqual(["Filen"])
		expect(drive.uploads).toEqual([])
	})

	it("stays stale when a read fails or another session saves during it", async () => {
		const drive = fakeDrive(serializeUserDictionary(addUserWord(emptyUserDictionary(), "zorp", 5)))
		const store = new UserDictionaryStore(drive.sdk, now)

		drive.sdk.listDirectory.mockRejectedValueOnce(new Error("offline"))
		await expect(store.load()).rejects.toThrow("offline")
		await store.load()
		expect(store.words()).toEqual(["zorp"])

		// A failed re-read leaves it stale: the next load reads again.
		store.markStale()
		drive.sdk.listDirectory.mockRejectedValueOnce(new Error("offline"))
		await expect(store.load()).rejects.toThrow("offline")
		drive.requests.length = 0
		await store.load()
		expect(drive.requests).toEqual(["find", "list", "download"])

		// A save elsewhere while the next read is in flight.
		const event = drive.saveElsewhere(serializeUserDictionary(addUserWord(emptyUserDictionary(), "Quux", 9)))

		store.markStale()

		const reading = store.load()

		store.handleDriveEvent(event)
		await reading
		drive.requests.length = 0
		// Read again (and the merged list written back).
		await store.load()
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(drive.requests).toContain("download")
		expect(store.words()).toEqual(["Quux", "zorp"])
	})

	it("tries a failed read again with backoff while someone listens, sooner after a reconnect", async () => {
		vi.useFakeTimers()

		try {
			const drive = fakeDrive(serializeUserDictionary(addUserWord(emptyUserDictionary(), "zorp", 5)))
			const store = new UserDictionaryStore(drive.sdk, now)
			const off = store.subscribe(() => undefined)

			drive.sdk.listDirectory.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"))
			await expect(store.load()).rejects.toThrow("offline")
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(1)

			// 5 s, then 10 s.
			await vi.advanceTimersByTimeAsync(4_999)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(1)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(2)
			await vi.advanceTimersByTimeAsync(9_999)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(2)
			await vi.advanceTimersByTimeAsync(1)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(3)
			expect(store.words()).toEqual(["zorp"])

			// Read: nothing more is fetched on its own.
			await vi.advanceTimersByTimeAsync(10 * 60_000)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(3)

			// A reconnect after a failure: tried 5 s after the last attempt rather than at the backoff's end.
			store.markStale()
			drive.sdk.listDirectory.mockRejectedValueOnce(new Error("offline"))
			await vi.advanceTimersByTimeAsync(500)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(4)
			store.markStale()
			await vi.advanceTimersByTimeAsync(4_999)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(4)
			await vi.advanceTimersByTimeAsync(1)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(5)
			off()
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not try a failed read again while nobody listens, nor after a reset", async () => {
		vi.useFakeTimers()

		try {
			const drive = fakeDrive(serializeUserDictionary(addUserWord(emptyUserDictionary(), "zorp", 5)))
			const store = new UserDictionaryStore(drive.sdk, now)

			drive.sdk.listDirectory.mockRejectedValueOnce(new Error("offline"))
			await expect(store.load()).rejects.toThrow("offline")
			await vi.advanceTimersByTimeAsync(60_000)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(1)

			const off = store.subscribe(() => undefined)

			drive.sdk.listDirectory.mockRejectedValueOnce(new Error("offline"))
			await expect(store.load()).rejects.toThrow("offline")
			store.reset()
			await vi.advanceTimersByTimeAsync(10 * 60_000)
			expect(drive.sdk.listDirectory).toHaveBeenCalledTimes(2)
			off()
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not download or overwrite an oversized file", async () => {
		const drive = fakeDrive(serializeUserDictionary(addUserWord(emptyUserDictionary(), "zorp", 5)))
		const store = new UserDictionaryStore(drive.sdk, now)
		const list = drive.sdk.listDirectory.getMockImplementation()

		drive.sdk.listDirectory.mockImplementation(async () =>
			(await (list?.() ?? Promise.resolve([]))).map(file => ({ ...file, size: BigInt(5 * 1024 * 1024) }))
		)
		await store.add("Filen")
		expect(drive.requests).not.toContain("download")
		expect(drive.uploads).toEqual([])
		expect(store.words()).toEqual(["Filen"])
	})

	it("forgets everything on reset and ignores answers from before it", async () => {
		const drive = fakeDrive(serializeUserDictionary(addUserWord(emptyUserDictionary(), "zorp", 5)))
		const store = new UserDictionaryStore(drive.sdk, now)
		const loading = store.load()

		store.reset()
		await loading
		expect(store.words()).toEqual([])

		await store.load()
		expect(store.words()).toEqual(["zorp"])
	})
})
