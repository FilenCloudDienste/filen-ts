import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { AnyFile, EntryDownloadReport, ReaderDownloadEntryParams, StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"
import type { RangePortApi } from "@/lib/media/rangePort"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"

// The byte layer's worker APIs against a stand-in client: only the wasm module and Comlink are replaced, so the
// preview-token registry, the port groups and the origin sources are the real ones.
interface WriterParams {
	writer: WritableStream<Uint8Array>
	start: bigint
	end: bigint
	managedFuture: { abortSignal: AbortSignal }
}

const { exposed, fakeClient, fakeReader, fakeUnauth } = vi.hoisted(() => {
	const fakeUnauth = {
		downloadFileToWriter: vi.fn<(params: WriterParams) => Promise<void>>(),
		writeEmbeddedPreview: vi.fn(),
		free: vi.fn()
	}

	const fakeReader = {
		format: { type: "zip" },
		entryByteAccess: vi.fn(() => Promise.resolve({ type: "whole", size: 10n })),
		downloadEntry: vi.fn<(params: ReaderDownloadEntryParams) => Promise<EntryDownloadReport>>(),
		writeEntryEmbeddedPreview: vi.fn(async (params: { writer: WritableStream<Uint8Array> }) => {
			const w = params.writer.getWriter()

			await w.write(new Uint8Array([0xff, 0xd8, 0xff]))
			await w.close()

			return { type: "preview", width: 3, height: 2, orientation: 1, bytes: 3n }
		}),
		close: vi.fn(),
		free: vi.fn()
	}

	return {
		exposed: new Map<"api", unknown>(),
		fakeUnauth,
		fakeReader,
		fakeClient: {
			root: () => ({ uuid: "root" }),
			getUnauthed: () => fakeUnauth,
			downloadFileToWriter: vi.fn<(params: WriterParams) => Promise<void>>(),
			openArchiveReader: vi.fn((_params: unknown, _password?: string) => Promise.resolve(fakeReader)),
			free: vi.fn()
		}
	}
})

vi.mock("@filen/sdk-rs", () => ({
	default: vi.fn(),
	initThreadPool: vi.fn(),
	UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => fakeClient }) }
}))

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>
const CONTENT = Array.from({ length: 10 }, (_, i) => i)

function fileOf(size: number): AnyFile {
	return { uuid: "d0000000-0000-0000-0000-000000000000", size: BigInt(size) } as unknown as AnyFile
}

async function serveContent(params: WriterParams): Promise<void> {
	const w = params.writer.getWriter()

	await w.write(new Uint8Array(CONTENT.slice(Number(params.start), Number(params.end))))
	await w.close()
}

// Comlink.expose (mocked) records the API it last exposed: right after a port opens, the port's own.
async function openPort(origin: ByteOrigin, token: string): Promise<RangePortApi> {
	const { port1 } = new MessageChannel()

	await api.openOriginRangePort(port1, origin, "authed", token)

	return exposed.get("api") as RangePortApi
}

function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

const NO_EVENTS = { phase: () => undefined, verified: () => undefined, failed: () => undefined }
const PLAN = { maxSolidSkip: 0, window: [{ index: 2, size: 10 }], windowSkip: 0 }

// A lease `id` on a reader of its own over a 100-byte archive.
async function lease(id: string, password?: string): Promise<void> {
	await api.openArchiveReader(`${id}-reader`, fileOf(100), false, password)
	await api.leaseArchiveEntry(id, `${id}-reader`, PLAN, NO_EVENTS)
}

async function unlease(id: string): Promise<void> {
	await api.releaseArchiveEntry(id)
	await api.closeArchiveReader(`${id}-reader`)
}

function entryOrigin(reader: string, access: "whole" | "mapped" = "whole", anon = false): ByteOrigin {
	return {
		kind: "entry",
		reader,
		entry: { archive: "d0000000-0000-0000-0000-000000000000", index: 2 },
		size: 10,
		access,
		anon,
		cacheKey: "x#2"
	}
}

beforeEach(async () => {
	await api.injectClient("session" as unknown as StringifiedClient)
	fakeClient.downloadFileToWriter.mockImplementation(serveContent)
	fakeUnauth.downloadFileToWriter.mockImplementation(serveContent)
	fakeReader.downloadEntry.mockImplementation(async params => {
		const w = params.writer.getWriter()

		await w.write(new Uint8Array(CONTENT))
		await w.close()

		return { checked: true } as EntryDownloadReport
	})
})

afterEach(() => {
	vi.clearAllMocks()
})

describe("sdk worker origin range ports", () => {
	it("serves a drive file's ranges through the session client", async () => {
		const port = await openPort({ kind: "file", file: fileOf(10) }, "o1")

		expect(Array.from(await port.read(2, 5, 1))).toEqual([2, 3, 4])
		expect(fakeClient.downloadFileToWriter.mock.calls[0]?.[0]).toMatchObject({ start: 2n, end: 5n })
		port.close()
	})

	it("ends only the port that closes, every port with the token, and frees a linked client once", async () => {
		const origin: ByteOrigin = { kind: "linkedFile", file: fileOf(10) }
		const first = await openPort(origin, "o2")
		const second = await openPort(origin, "o2")

		first.close()
		await settle()
		await settle()

		expect(Array.from(await second.read(0, 2, 1))).toEqual([0, 1])
		expect(fakeUnauth.free).not.toHaveBeenCalled()

		await api.cancelPreviewDownload("o2")
		await settle()

		await expect(second.read(0, 2, 2)).rejects.toThrow()
		expect(fakeUnauth.free).toHaveBeenCalledTimes(1)
	})

	it("serves an entry's ranges from one checked whole read shared by the token's ports", async () => {
		const reader = { id: "reader-1" }
		await lease(reader.id)
		const first = await openPort(entryOrigin(reader.id), "o3")
		const second = await openPort(entryOrigin(reader.id), "o3")

		expect(Array.from(await first.read(0, 3, 1))).toEqual([0, 1, 2])
		expect(Array.from(await second.read(7, 10, 1))).toEqual([7, 8, 9])
		expect(fakeReader.downloadEntry).toHaveBeenCalledTimes(1)
		expect(fakeReader.downloadEntry.mock.calls[0]?.[0]).toMatchObject({ maxSolidSkip: 0, entry: { index: 2 } })

		await api.cancelPreviewDownload("o3")
		await unlease(reader.id)
	})

	it("closes the previous account's readers and leases when another client is adopted", async () => {
		await lease("reader-switch")
		expect(Array.from(await api.downloadOriginBytes(entryOrigin("reader-switch"), "authed", 10, "o5a"))).toEqual(CONTENT)
		await api.injectClient("other" as unknown as StringifiedClient)

		await expect(api.downloadOriginBytes(entryOrigin("reader-switch"), "authed", 10, "o5")).rejects.toThrow("closed")
		expect(fakeReader.close).toHaveBeenCalled()
		await unlease("reader-switch")
	})

	it("refuses an entry whose reader is closed", async () => {
		await expect(openPort(entryOrigin("closed"), "o4")).rejects.toThrow("closed")
	})

	it("cancels the reads of a lease taken on a reader closed already, on a public link's surface too", async () => {
		await api.leaseArchiveEntry("late", "never-opened", PLAN, NO_EVENTS)

		for (const anon of [false, true]) {
			await expect(
				api.downloadOriginBytes(entryOrigin("late", "whole", anon), anon ? "anon" : "authed", 10, "o6")
			).rejects.toMatchObject({
				kind: "Cancelled"
			})
		}

		await api.releaseArchiveEntry("late")
	})
})

describe("sdk worker origin access", () => {
	it("refuses an origin that needs a session to a public link's surface on every origin call", async () => {
		const origin: ByteOrigin = { kind: "file", file: fileOf(10) }
		const { port1 } = new MessageChannel()

		await expect(api.downloadOriginBytes(origin, "anon", 10, "a1")).rejects.toThrow("needs a session")
		await expect(api.openOriginRangePort(port1, origin, "anon", "a2")).rejects.toThrow("needs a session")
		await expect(api.openOriginSyncRange(new SharedArrayBuffer(8), port1, origin, "anon", "a3", "lock")).rejects.toThrow(
			"needs a session"
		)
		await expect(api.readOriginProbe(origin, "anon", "card", "a4")).rejects.toThrow("needs a session")
		await expect(api.fetchOriginRawPreview(origin, "anon", "a5")).rejects.toThrow("needs a session")
		expect(fakeClient.downloadFileToWriter).not.toHaveBeenCalled()
	})

	it("reads a linked file for a public link's surface through the unauthenticated client", async () => {
		expect(Array.from(await api.downloadOriginBytes({ kind: "linkedFile", file: fileOf(10) }, "anon", 10, "a6"))).toEqual(CONTENT)
		expect(fakeUnauth.downloadFileToWriter).toHaveBeenCalledTimes(1)
		expect(fakeClient.downloadFileToWriter).not.toHaveBeenCalled()
	})
})

describe("sdk worker whole origin reads", () => {
	it("downloads a file's whole bytes under its cap and refuses above it", async () => {
		expect(Array.from(await api.downloadOriginBytes({ kind: "file", file: fileOf(10) }, "authed", 10, "w1"))).toEqual(CONTENT)
		await expect(api.downloadOriginBytes({ kind: "file", file: fileOf(10) }, "authed", 9, "w2")).rejects.toThrow("cap")
	})

	it("reads an entry whole through the checked entry download", async () => {
		const reader = { id: "reader-2" }
		await lease(reader.id, "pw")

		expect(Array.from(await api.downloadOriginBytes(entryOrigin(reader.id), "authed", 10, "w3"))).toEqual(CONTENT)
		expect(fakeClient.openArchiveReader.mock.calls[0]?.[1]).toBe("pw")
		await unlease(reader.id)
	})

	it("has no sync range for an origin read whole, and walks a RAW entry's embedded preview through its reader", async () => {
		const { port1 } = new MessageChannel()
		const reader = { id: "reader-3" }
		await lease(reader.id)

		await expect(
			api.openOriginSyncRange(new SharedArrayBuffer(8), port1, entryOrigin(reader.id), "authed", "s1", "lock")
		).rejects.toThrow("read whole")
		await expect(api.fetchOriginRawPreview(entryOrigin(reader.id), "authed", "r1")).resolves.toMatchObject({ type: "preview" })
		expect(fakeReader.writeEntryEmbeddedPreview).toHaveBeenCalledWith(
			expect.objectContaining({ entry: { archive: "d0000000-0000-0000-0000-000000000000", index: 2 } })
		)
		await unlease(reader.id)
		await expect(api.fetchOriginRawPreview(entryOrigin(reader.id), "authed", "r2")).rejects.toThrow()
	})
})
