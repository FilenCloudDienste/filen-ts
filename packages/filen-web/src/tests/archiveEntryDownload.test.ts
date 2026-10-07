import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile, UuidStr } from "@filen/sdk-rs"
import type { EntryJobParams, EntryProgress } from "@/workers/sdk.worker"
import type { FsaSaveTarget, SaveTarget, SwSaveTarget } from "@/features/drive/lib/saveDownload"
import { ErrorWithDTO, plainErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { Transfer, TerminalStatus } from "@/features/transfers/store/useTransfersStore"

// One archive entry saved on its own: the transfers row and its outcomes, and the two save paths — the
// picked file, and the service worker, whose download starts only once the SDK wrote its first byte.

const { downloadArchiveEntry, cancelTransfer } = vi.hoisted(() => ({
	downloadArchiveEntry:
		vi.fn<
			(
				transferId: string,
				params: EntryJobParams,
				password: string | undefined,
				writer: WritableStream<Uint8Array>,
				onUpdate: (progress: EntryProgress) => void
			) => Promise<boolean>
		>(),
	cancelTransfer: vi.fn<(id: string) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { downloadArchiveEntry, cancelTransfer } }))
vi.mock("comlink", () => ({ proxy: (value: unknown) => value, transfer: (value: unknown) => value }))
vi.mock("@/queries/client", () => ({ queryClient: {} }))
vi.mock("@/features/transfers/lib/transferStartToast", () => ({ toastTransferStarted: vi.fn() }))

const { saveStreamDownload, triggerSwStreamDownload, assertSwControlled } = vi.hoisted(() => ({
	saveStreamDownload: vi.fn<(name: string) => Promise<SaveTarget>>(),
	triggerSwStreamDownload:
		vi.fn<
			(
				save: SwSaveTarget,
				transferId: string,
				readable: ReadableStream<Uint8Array>,
				size: number,
				onCancel: () => void
			) => Promise<void>
		>(),
	assertSwControlled: vi.fn()
}))

vi.mock("@/features/drive/lib/saveDownload", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/saveDownload")>()),
	saveStreamDownload,
	triggerSwStreamDownload,
	assertSwControlled
}))

const { runEntryDownload, defaultEntryDownloadDeps, isArchivePasswordError } = await import("@/features/archive/lib/entryDownload")

type EntryRequest = Parameters<typeof runEntryDownload>[1]["request"]
type Reporters = Parameters<typeof defaultEntryDownloadDeps.download>[4]

// What a worker call rejects with, as the page sees it: the error's DTO.
function rejection(message: string, kind?: string): ErrorWithDTO {
	return new ErrorWithDTO(plainErrorDTO(message, kind))
}

const ARCHIVE_UUID = "0a0a0a0a-0000-4000-8000-000000000000" as UuidStr
const REQUEST: EntryRequest = {
	params: { archive: { uuid: ARCHIVE_UUID } as unknown as AnyFile, entry: { archive: ARCHIVE_UUID, index: 2 }, maxSolidSkip: 0 },
	name: "notes.txt",
	size: 3
}
const SW_SAVE: SwSaveTarget = { kind: "sw", id: "sw-1", url: "/sw/download/sw-1", name: "notes.txt" }

function fakeStore() {
	return {
		add: vi.fn<(transfer: Omit<Transfer, "paused">) => void>(),
		setProgress: vi.fn<(id: string, bytes: number) => void>(),
		setWaitingForSlot: vi.fn<(id: string, waiting: boolean) => void>(),
		settle: vi.fn<(id: string, status: TerminalStatus, error?: ErrorDTO) => void>(),
		remove: vi.fn<(id: string) => void>()
	}
}

beforeEach(() => {
	saveStreamDownload.mockResolvedValue(SW_SAVE)
	cancelTransfer.mockResolvedValue()
})

afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe("runEntryDownload", () => {
	it("does nothing for a cancelled picker", async () => {
		saveStreamDownload.mockRejectedValue(Object.assign(new Error("dismissed"), { name: "AbortError" }))

		const store = fakeStore()
		const download = vi.fn()

		await expect(runEntryDownload({ download, store }, { request: REQUEST, password: undefined })).resolves.toEqual({
			status: "success"
		})
		expect(store.add).not.toHaveBeenCalled()
		expect(download).not.toHaveBeenCalled()
	})

	it("adds one row at the listed size, reports progress and the slot wait, and settles it done", async () => {
		const store = fakeStore()
		const onVerified = vi.fn()
		const download = vi.fn(
			(_request: EntryRequest, _id: string, _save: SaveTarget, _password: string | undefined, report: Reporters) => {
				report.waiting(true)
				report.waiting(false)
				report.progress(3)

				return Promise.resolve(true)
			}
		)

		await expect(runEntryDownload({ download, store }, { request: REQUEST, password: "pw", onVerified })).resolves.toEqual({
			status: "success"
		})

		const id = String(store.add.mock.calls[0]?.[0].id)

		expect(store.add).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "download", name: "notes.txt", size: 3, status: "downloading", browserManaged: true })
		)
		expect(download).toHaveBeenCalledWith(REQUEST, id, SW_SAVE, "pw", expect.anything())
		expect(store.setWaitingForSlot.mock.calls).toEqual([
			[id, true],
			[id, false]
		])
		expect(store.setProgress).toHaveBeenCalledWith(id, 3)
		expect(store.settle).toHaveBeenCalledWith(id, "done")
		expect(onVerified).toHaveBeenCalledOnce()
	})

	it("proves no password with an entry that has no checksum, staying silent about it", async () => {
		const store = fakeStore()
		const onVerified = vi.fn()

		await expect(
			runEntryDownload({ download: () => Promise.resolve(false), store }, { request: REQUEST, password: "maybe", onVerified })
		).resolves.toEqual({ status: "success" })
		expect(store.settle).toHaveBeenCalledWith(expect.any(String), "done")
		expect(onVerified).not.toHaveBeenCalled()
	})

	it("asks for the password instead of failing, the row gone", async () => {
		const store = fakeStore()
		const onVerified = vi.fn()
		const download = vi.fn(() => Promise.reject(rejection("needs one", "ArchivePasswordRequired")))

		await expect(runEntryDownload({ download, store }, { request: REQUEST, password: undefined, onVerified })).resolves.toEqual({
			status: "password",
			wrong: false
		})
		await expect(runEntryDownload({ download, store }, { request: REQUEST, password: "typo", onVerified })).resolves.toEqual({
			status: "password",
			wrong: true
		})
		expect(store.remove).toHaveBeenCalledTimes(2)
		expect(store.settle).not.toHaveBeenCalledWith(expect.anything(), "error", expect.anything())
		expect(onVerified).not.toHaveBeenCalled()
		expect(isArchivePasswordError(plainErrorDTO("x", "ArchiveWrongPassword"))).toBe(true)
	})

	it("drops a cancelled row and keeps a failed one", async () => {
		const store = fakeStore()

		await expect(
			runEntryDownload(
				{ download: () => Promise.reject(rejection("stop", "Cancelled")), store },
				{ request: REQUEST, password: undefined }
			)
		).resolves.toEqual({ status: "success" })
		expect(store.remove).toHaveBeenCalledOnce()

		const skip = plainErrorDTO("too much", "ArchiveSolidSkipExceeded")
		const outcome = await runEntryDownload(
			{ download: () => Promise.reject(new ErrorWithDTO(skip)), store },
			{ request: REQUEST, password: undefined }
		)

		expect(outcome).toEqual({ status: "error", dto: skip, browserManaged: true })
		expect(store.settle).toHaveBeenLastCalledWith(expect.any(String), "error", skip)
	})
})

// The SDK's side as the bridge hands it over: writes `chunks` into the transferred writable when told.
function scriptedSdk(): {
	write: (chunk: number[]) => Promise<void>
	// `checked`: the entry matched its checksum.
	finish: (checked?: boolean) => Promise<void>
	fail: (error: ErrorWithDTO) => void
} {
	const settle = Promise.withResolvers<boolean>()
	let writer: WritableStreamDefaultWriter<Uint8Array> | null = null

	downloadArchiveEntry.mockImplementation((_id, _params, _password, writable) => {
		writer = writable.getWriter()

		return settle.promise
	})

	function current(): WritableStreamDefaultWriter<Uint8Array> {
		if (writer === null) {
			throw new Error("no download")
		}

		return writer
	}

	return {
		write: chunk => current().write(new Uint8Array(chunk)),
		finish: async (checked = true) => {
			await current().close()
			settle.resolve(checked)
		},
		fail: error => {
			void current().abort(error.message)
			settle.reject(error)
		}
	}
}

async function drain(readable: ReadableStream<Uint8Array>): Promise<number[]> {
	const out: number[] = []

	for await (const chunk of readable) {
		out.push(...chunk)
	}

	return out
}

function report() {
	return { progress: vi.fn(), waiting: vi.fn() }
}

describe("an entry saved through the service worker", () => {
	it("starts the browser's download only once the first byte is written, then streams the rest", async () => {
		const sdk = scriptedSdk()
		const delivered = Promise.withResolvers<undefined>()
		const drained: Promise<number[]>[] = []

		triggerSwStreamDownload.mockImplementation((_save, _id, readable) => {
			drained.push(drain(readable))

			return delivered.promise
		})

		const running = defaultEntryDownloadDeps.download(REQUEST, "t-1", SW_SAVE, undefined, report())

		await vi.waitFor(() => {
			expect(downloadArchiveEntry).toHaveBeenCalled()
		})
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(triggerSwStreamDownload).not.toHaveBeenCalled()

		void sdk.write([1, 2])

		await vi.waitFor(() => {
			expect(triggerSwStreamDownload).toHaveBeenCalledWith(SW_SAVE, "t-1", expect.any(ReadableStream), 3, expect.any(Function))
		})

		void sdk.write([3])
		await sdk.finish()
		delivered.resolve(undefined)

		expect(await running).toBe(true)
		expect(await drained[0]).toEqual([1, 2, 3])
		expect(assertSwControlled).toHaveBeenCalled()
	})

	it("starts no browser download for an entry that fails before its first byte", async () => {
		const sdk = scriptedSdk()
		const running = defaultEntryDownloadDeps.download(REQUEST, "t-2", SW_SAVE, "wrong", report())

		await vi.waitFor(() => {
			expect(downloadArchiveEntry).toHaveBeenCalled()
		})
		sdk.fail(rejection("wrong", "ArchiveWrongPassword"))

		await expect(running).rejects.toMatchObject({ dto: { kind: "ArchiveWrongPassword" } })
		expect(triggerSwStreamDownload).not.toHaveBeenCalled()
	})

	it("hands an empty entry over once the SDK finished it", async () => {
		const sdk = scriptedSdk()

		triggerSwStreamDownload.mockImplementation(async (_save, _id, readable) => {
			expect(await drain(readable)).toEqual([])
		})

		const running = defaultEntryDownloadDeps.download({ ...REQUEST, size: 0 }, "t-3", SW_SAVE, undefined, report())

		await vi.waitFor(() => {
			expect(downloadArchiveEntry).toHaveBeenCalled()
		})
		await sdk.finish(false)

		expect(await running).toBe(false)
		expect(triggerSwStreamDownload).toHaveBeenCalledOnce()
	})

	it("stops the SDK when the browser's download fails first, failing with the worker's report", async () => {
		const sdk = scriptedSdk()
		const swFailure = rejection("the download stopped responding")

		triggerSwStreamDownload.mockImplementation(() => Promise.reject(swFailure))
		cancelTransfer.mockImplementation(() => {
			sdk.fail(rejection("stop", "Cancelled"))

			return Promise.resolve()
		})

		const running = defaultEntryDownloadDeps.download(REQUEST, "t-4", SW_SAVE, undefined, report())

		await vi.waitFor(() => {
			expect(downloadArchiveEntry).toHaveBeenCalled()
		})
		void sdk.write([1]).catch(() => undefined)

		await expect(running).rejects.toBe(swFailure)
		expect(cancelTransfer).toHaveBeenCalledWith("t-4")
	})

	it("fails with the SDK's own error when it is the cause", async () => {
		const sdk = scriptedSdk()
		const delivered = Promise.withResolvers<undefined>()

		triggerSwStreamDownload.mockImplementation(() => delivered.promise)

		const running = defaultEntryDownloadDeps.download(REQUEST, "t-5", SW_SAVE, undefined, report())

		await vi.waitFor(() => {
			expect(downloadArchiveEntry).toHaveBeenCalled()
		})
		void sdk.write([1]).catch(() => undefined)
		await vi.waitFor(() => {
			expect(triggerSwStreamDownload).toHaveBeenCalled()
		})

		const corrupt = rejection("damaged", "ArchiveCorrupt")

		sdk.fail(corrupt)
		await new Promise(resolve => setTimeout(resolve, 0))
		delivered.reject(rejection("stream errored"))

		await expect(running).rejects.toBe(corrupt)
	})

	it("names a cancel from the browser's own UI a cancel, whichever side reports first", async () => {
		for (const sdkFirst of [true, false]) {
			vi.clearAllMocks()

			const sdk = scriptedSdk()
			const delivered = Promise.withResolvers<undefined>()

			triggerSwStreamDownload.mockImplementation(() => delivered.promise)

			const running = defaultEntryDownloadDeps.download(REQUEST, "t-9", SW_SAVE, undefined, report())

			await vi.waitFor(() => {
				expect(downloadArchiveEntry).toHaveBeenCalled()
			})
			void sdk.write([1]).catch(() => undefined)
			await vi.waitFor(() => {
				expect(triggerSwStreamDownload).toHaveBeenCalled()
			})

			// The browser cancelled the body: the SDK's next write fails, the worker reports a cancel.
			const writeFailed = rejection("stream closed", "IO")
			const cancelled = rejection("download cancelled", "Cancelled")

			if (sdkFirst) {
				sdk.fail(writeFailed)
				await new Promise(resolve => setTimeout(resolve, 0))
				delivered.reject(cancelled)
			} else {
				delivered.reject(cancelled)
				await new Promise(resolve => setTimeout(resolve, 0))
				sdk.fail(writeFailed)
			}

			await expect(running).rejects.toBe(cancelled)
		}
	})

	it("hands the row's Cancel to the SDK as well", async () => {
		const sdk = scriptedSdk()

		triggerSwStreamDownload.mockImplementation((_save, _id, _readable, _size, onCancel) => {
			onCancel()

			return Promise.resolve()
		})

		const running = defaultEntryDownloadDeps.download(REQUEST, "t-6", SW_SAVE, undefined, report())

		await vi.waitFor(() => {
			expect(downloadArchiveEntry).toHaveBeenCalled()
		})
		void sdk.write([1]).catch(() => undefined)
		await vi.waitFor(() => {
			expect(cancelTransfer).toHaveBeenCalledWith("t-6")
		})
		await sdk.finish().catch(() => undefined)
		await running.catch(() => undefined)
	})
})

describe("an entry saved into a picked file", () => {
	function pickedFile(): { save: FsaSaveTarget; written: number[]; removed: () => boolean } {
		const written: number[] = []
		let removed = false
		const writable = new WritableStream<Uint8Array>({
			write(chunk) {
				written.push(...chunk)
			}
		}) as unknown as FileSystemWritableFileStream

		return {
			save: {
				kind: "fsa",
				writable,
				handle: {
					remove: () => {
						removed = true

						return Promise.resolve()
					}
				} as unknown as FileSystemFileHandle
			},
			written,
			removed: () => removed
		}
	}

	it("streams into it, and discards it when the entry fails", async () => {
		const ok = pickedFile()
		const progress = report()

		downloadArchiveEntry.mockImplementationOnce(async (_id, _params, _password, writable, onUpdate) => {
			const writer = writable.getWriter()

			onUpdate({ phase: "waitingForWorker", bytesWritten: 0 })
			await writer.write(new Uint8Array([7, 8]))
			onUpdate({ phase: "reading", bytesWritten: 2 })
			await writer.close()

			return true
		})

		await expect(defaultEntryDownloadDeps.download(REQUEST, "t-7", ok.save, undefined, progress)).resolves.toBe(true)

		expect(ok.written).toEqual([7, 8])
		expect(progress.waiting.mock.calls).toEqual([[true], [false]])
		expect(progress.progress).toHaveBeenLastCalledWith(2)

		const bad = pickedFile()

		downloadArchiveEntry.mockImplementationOnce(() => Promise.reject(rejection("damaged", "ArchiveCorrupt")))

		await expect(defaultEntryDownloadDeps.download(REQUEST, "t-8", bad.save, undefined, report())).rejects.toMatchObject({
			dto: { kind: "ArchiveCorrupt" }
		})
		expect(bad.removed()).toBe(true)
	})
})
