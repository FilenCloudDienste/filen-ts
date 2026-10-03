import { beforeEach, describe, expect, it, vi } from "vitest"
import { onlineManager, QueryClient } from "@tanstack/react-query"
import type { CompressFormat, Dir, File, LinkedFile, SharedFile, UserInfo, UuidStr } from "@filen/sdk-rs"
import type { ArchiveFormatInfo, ArchiveNameInfo } from "@/workers/sdk.worker"
import type { CompressJobRequest, ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"

const {
	archiveFormatInfo,
	archiveNameInfo,
	kvGetJson,
	toastError,
	startCompressWithCard,
	startExtractWithCard,
	startExtractBatchWithCards
} = vi.hoisted(() => ({
	archiveFormatInfo: vi.fn<(formats: CompressFormat[]) => Promise<ArchiveFormatInfo[]>>(),
	archiveNameInfo: vi.fn<(names: string[]) => Promise<ArchiveNameInfo[]>>(),
	kvGetJson: vi.fn<() => Promise<unknown>>(),
	toastError: vi.fn<(message: string) => void>(),
	startCompressWithCard: vi.fn<(request: Omit<CompressJobRequest, "id">, password: string | undefined) => string>(),
	startExtractWithCard: vi.fn<(request: Omit<ExtractJobRequest, "id">, password: string | undefined) => string>(),
	startExtractBatchWithCards: vi.fn<(requests: readonly Omit<ExtractJobRequest, "id">[]) => string[]>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { archiveFormatInfo, archiveNameInfo } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson: vi.fn(() => Promise.resolve()) }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))
vi.mock("@/features/transfers/lib/archiveToast", () => ({ startCompressWithCard, startExtractWithCard, startExtractBatchWithCards }))

import "@/lib/i18n"
import { linkedFileIntoDriveItem, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { linkedArchiveSource } from "@/features/archive/lib/archiveSource"
import type { CompressPreferences } from "@/features/drive/lib/compressPreferences"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { testUuid } from "@/tests/support/uuid"
import { sdkErrorDTO } from "@/tests/support/sdkError"

const ROOT = testUuid("root")
const PARENT = testUuid("parent")

type ActionsModule = typeof import("@/features/drive/lib/archiveActions")

// The preferences, format answers and name answers are memoised per page: a fresh module each test.
async function load(): Promise<ActionsModule> {
	vi.resetModules()

	return await import("@/features/drive/lib/archiveActions")
}

function file(name: string, parent: string = PARENT): DriveItem {
	const raw: File = {
		uuid: testUuid(name),
		stableUUID: undefined,
		parent: parent as UuidStr,
		size: 100n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 100n, key: "k", version: 2 } }
	}

	return narrowItem(raw)
}

function dir(name: string, parent: string = PARENT): DriveItem {
	const raw: Dir = {
		uuid: testUuid(name),
		parent: parent as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}

	return narrowItem(raw)
}

function sharedRootFile(name: string): DriveItem {
	const raw: SharedFile = {
		uuid: testUuid(name),
		size: 100n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 1n,
		timestamp: 0n,
		meta: { type: "decoded", data: { name, mime: "application/zip", modified: 0n, size: 100n, key: "k", version: 2 } },
		sharingRole: { type: "receiver", email: "a@example.com", id: 1 },
		sharedTag: true,
		canMakeThumbnail: false
	}

	return narrowItem(raw)
}

const EXTENSIONS: Record<CompressFormat["type"], string> = { zip: ".zip", sevenZ: ".7z", tar: ".tar.gz", single: ".gz" }

function answerFormats(overrides: Partial<ArchiveFormatInfo> = {}): void {
	archiveFormatInfo.mockImplementation(formats =>
		Promise.resolve(
			formats.map(format => ({
				extension: EXTENSIONS[format.type],
				levels: format.type === "zip" && format.method.type === "stored" ? null : { min: 1, max: 9, defaultLevel: 6 },
				maxLevel: 5,
				encoderMemory: 1024,
				...overrides
			}))
		)
	)
}

function answerNames(): void {
	archiveNameInfo.mockImplementation(names =>
		Promise.resolve(
			names.map(name =>
				name.endsWith(".gz") && !name.endsWith(".tar.gz")
					? { format: { type: "single", codec: "gzip" }, defaultName: name.slice(0, -3) }
					: { format: { type: "zip" }, defaultName: name.replace(/\.[^.]+$/, "") }
			)
		)
	)
}

function storedPreferences(prefs: CompressPreferences | null): void {
	kvGetJson.mockResolvedValue(prefs)
}

function compressRequest(): Omit<CompressJobRequest, "id"> | undefined {
	return startCompressWithCard.mock.calls[0]?.[0]
}

beforeEach(() => {
	onlineManager.setOnline(true)
	queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT })
	storedPreferences(null)
	answerFormats()
	answerNames()
	startCompressWithCard.mockReturnValue("job")
	startExtractWithCard.mockReturnValue("job")
	startExtractBatchWithCards.mockImplementation(requests => requests.map((_, index) => `job${String(index)}`))
})

describe("compressWithPreset", () => {
	it("starts the preset with the SDK's default level clamped to the codec memory, no password, nothing removed", async () => {
		const { compressWithPreset } = await load()
		const items = [file("report.pdf", ROOT)]

		await compressWithPreset(items, "drive", "zip")

		expect(startCompressWithCard).toHaveBeenCalledTimes(1)
		expect(startCompressWithCard.mock.calls[0]?.[1]).toBeUndefined()
		expect(compressRequest()).toEqual({
			source: { kind: "items", items },
			destination: { uuid: null, name: "Cloud Drive" },
			name: "report.zip",
			format: { type: "zip", method: { type: "deflate", level: 5 } },
			encrypted: false,
			dispose: null,
			itemCount: 1
		})
	})

	it("runs with the options last used for the format, a stored level clamped again", async () => {
		const { compressWithPreset } = await load()

		storedPreferences({
			format: "zip",
			zip: { method: "deflate", level: 3, aes: "aes128" },
			sevenZ: { method: "ppmd", level: 8, solid: false, encryptNames: true },
			levels: { "tar.gz": 2 }
		})

		await compressWithPreset([file("a.txt"), dir("b")], "drive", "7z")
		await compressWithPreset([file("a.txt")], "drive", "tar.gz")

		expect(startCompressWithCard.mock.calls[0]?.[0].format).toStrictEqual({
			type: "sevenZ",
			method: { type: "ppmd", level: 5 },
			solid: false
		})
		expect(startCompressWithCard.mock.calls[1]?.[0].format).toStrictEqual({ type: "tar", compression: { codec: "gzip", level: 2 } })
	})

	it("asks the worker once for the preferences and the format, and not again on a second click", async () => {
		const { compressWithPreset } = await load()

		await compressWithPreset([file("a.txt")], "drive", "zip")
		await compressWithPreset([file("b.txt")], "drive", "zip")

		expect(kvGetJson).toHaveBeenCalledTimes(1)
		expect(archiveFormatInfo).toHaveBeenCalledTimes(1)
		expect(archiveFormatInfo.mock.calls[0]?.[0]).toEqual([{ type: "zip", method: { type: "deflate", level: 1 } }])
		expect(startCompressWithCard).toHaveBeenCalledTimes(2)
	})

	it("names several items after their directory and saves next to them", async () => {
		const { compressWithPreset } = await load()

		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: null }), [dir("parent", ROOT)])

		await compressWithPreset([file("a.txt"), dir("b")], "drive", "tar.gz")

		expect(compressRequest()?.destination).toEqual({ uuid: PARENT, name: "parent" })
		expect(compressRequest()?.name).toBe("parent.tar.gz")
		expect(compressRequest()?.itemCount).toBe(2)
	})

	it("saves to My Drive's root from Shared with me, as Archive for several items", async () => {
		const { compressWithPreset } = await load()

		await compressWithPreset([sharedRootFile("a.zip"), sharedRootFile("b.zip")], "sharedIn", "zip")

		expect(compressRequest()?.destination).toEqual({ uuid: null, name: "Cloud Drive" })
		expect(compressRequest()?.name).toBe("Archive.zip")
		expect(compressRequest()?.dispose).toBeNull()
	})

	it("names items from different directories after the caller's fallback, one directory by the caller's own lookup", async () => {
		const { compressWithPreset } = await load()
		const work = testUuid("work")

		await compressWithPreset([file("a.jpg"), file("b.jpg", work)], "drive", "zip", { mixedFallback: "Photos" })
		await compressWithPreset([file("a.jpg"), file("b.jpg")], "drive", "zip", {
			nameOf: uuid => (uuid === PARENT ? "Italy" : undefined),
			mixedFallback: "Photos"
		})

		expect(startCompressWithCard.mock.calls[0]?.[0]).toMatchObject({
			name: "Photos.zip",
			destination: { uuid: null, name: "Cloud Drive" }
		})
		expect(startCompressWithCard.mock.calls[1]?.[0]).toMatchObject({ name: "Italy.zip", destination: { uuid: PARENT, name: "Italy" } })
	})

	it("starts nothing when not even the lowest level fits, and points to Advanced settings", async () => {
		const { compressWithPreset } = await load()

		answerFormats({ maxLevel: null })

		await compressWithPreset([file("a.txt")], "drive", "7z")

		expect(startCompressWithCard).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledWith(expect.stringContaining("7-Zip needs more archive memory than Advanced settings allow"))
	})

	it("shows the worker's error", async () => {
		const { compressWithPreset } = await load()

		archiveFormatInfo.mockRejectedValue(sdkErrorDTO("Unknown", "worker gone"))

		await compressWithPreset([file("a.txt")], "drive", "zip")

		expect(startCompressWithCard).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledTimes(1)
	})
})

describe("extractQuick", () => {
	it("extracts one archive into a new directory next to it", async () => {
		const { extractQuick } = await load()
		const zip = file("photos.zip", ROOT)

		await extractQuick([zip], "drive", { type: "hereNewFolder" })

		expect(startExtractWithCard).toHaveBeenCalledTimes(1)
		expect(startExtractWithCard.mock.calls[0]?.[1]).toBeUndefined()
		expect(startExtractWithCard.mock.calls[0]?.[0]).toMatchObject({
			destination: { uuid: null, name: "Cloud Drive" },
			root: { type: "newFolder" },
			rowName: "photos",
			calls: [{ type: "all" }],
			dispose: null
		})
		expect(startExtractBatchWithCards).not.toHaveBeenCalled()
	})

	it("extracts one archive straight into its directory", async () => {
		const { extractQuick } = await load()

		await extractQuick([file("photos.zip", ROOT)], "drive", { type: "here" })

		expect(startExtractWithCard.mock.calls[0]?.[0].root).toEqual({ type: "destination" })
	})

	it("queues several archives together, each into a new directory of its own, with one name call", async () => {
		const { extractQuick } = await load()
		const destination = { uuid: PARENT, name: "Parent" }

		await extractQuick([file("a.zip"), file("b.zip"), file("c.txt.gz")], "drive", { type: "here" })
		await extractQuick([file("d.zip"), file("e.zip")], "sharedIn", { type: "to", destination })

		expect(archiveNameInfo).toHaveBeenCalledTimes(2)
		expect(startExtractWithCard).not.toHaveBeenCalled()

		const [here, to] = startExtractBatchWithCards.mock.calls.map(call => call[0])

		expect(here?.map(request => request.root)).toEqual([{ type: "newFolder" }, { type: "newFolder" }, { type: "newFolder" }])
		expect(here?.map(request => request.glyph)).toEqual(["directory", "directory", "file"])
		expect(to?.every(request => request.destination === destination)).toBe(true)
	})

	it("asks for a new directory even here for a single compressed file by its name, which the SDK ignores for a real one", async () => {
		const { extractQuick } = await load()

		await extractQuick([file("notes.txt.gz", ROOT)], "drive", { type: "here" })

		expect(startExtractWithCard.mock.calls[0]?.[0]).toMatchObject({
			destination: { uuid: null },
			root: { type: "newFolder" },
			rowName: "notes.txt",
			glyph: "file"
		})
	})

	it("starts nothing for here in Shared with me", async () => {
		const { extractQuick } = await load()

		await extractQuick([sharedRootFile("a.zip")], "sharedIn", { type: "hereNewFolder" })
		await extractQuick([sharedRootFile("a.zip"), sharedRootFile("b.zip")], "sharedIn", { type: "here" })

		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(startExtractBatchWithCards).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("starts nothing offline, saying why", async () => {
		const { extractQuick, compressWithPreset } = await load()

		onlineManager.setOnline(false)

		await extractQuick([file("a.zip")], "drive", { type: "hereNewFolder" })
		await compressWithPreset([file("a.pdf")], "drive", "zip")

		expect(archiveNameInfo).not.toHaveBeenCalled()
		expect(archiveFormatInfo).not.toHaveBeenCalled()
		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(startCompressWithCard).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledTimes(2)
	})

	it("shows the worker's error", async () => {
		const { extractQuick } = await load()

		archiveNameInfo.mockRejectedValue(sdkErrorDTO("Unknown", "worker gone"))

		await extractQuick([file("a.zip")], "drive", { type: "hereNewFolder" })

		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledTimes(1)
	})
})

describe("extractArchiveTo", () => {
	const LINKED: LinkedFile = {
		uuid: testUuid("linked"),
		name: { Decrypted: "photos.zip" },
		mime: { Decrypted: "application/zip" },
		size: 2048n,
		chunks: 1n,
		region: "de-1",
		bucket: "filen-1",
		version: 2,
		timestamp: 0n,
		fileKey: "k",
		downloadable: true,
		linkedTag: true,
		canMakeThumbnail: false
	}
	const SOURCE = linkedArchiveSource(linkedFileIntoDriveItem(LINKED), LINKED)
	const DESTINATION = { uuid: PARENT, name: "parent" }

	it("extracts the whole archive into a new directory there, never removing it, asking for its name once", async () => {
		const { extractArchiveTo } = await load()

		await extractArchiveTo(SOURCE, DESTINATION)
		await extractArchiveTo(SOURCE, DESTINATION)

		expect(archiveNameInfo).toHaveBeenCalledTimes(1)
		expect(startExtractWithCard).toHaveBeenCalledTimes(2)
		expect(startExtractWithCard.mock.calls[0]).toEqual([
			{
				archive: { file: LINKED, uuid: LINKED.uuid, name: "photos.zip" },
				destination: DESTINATION,
				root: { type: "newFolder" },
				rowName: "photos",
				glyph: "directory",
				calls: [{ type: "all" }],
				skipMacMetadata: true,
				dispose: null,
				basis: { type: "archiveRead" },
				formatHint: "zip"
			},
			undefined
		])
	})

	it("starts nothing offline, saying why", async () => {
		const { extractArchiveTo } = await load()

		onlineManager.setOnline(false)

		await extractArchiveTo(SOURCE, DESTINATION)

		expect(archiveNameInfo).not.toHaveBeenCalled()
		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledTimes(1)
	})

	it("shows the worker's error", async () => {
		const { extractArchiveTo } = await load()

		archiveNameInfo.mockRejectedValue(sdkErrorDTO("Unknown", "worker gone"))

		await extractArchiveTo(SOURCE, DESTINATION)

		expect(startExtractWithCard).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledTimes(1)
	})
})
