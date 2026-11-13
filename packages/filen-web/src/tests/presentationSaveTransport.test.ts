import { afterEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import { crc32 } from "@filen/office/core/opc"
import { savePortReader, savePortWriter, SavePortAbortedError } from "@filen/shared/savePort"
import type { PortLike, SaveResult } from "@filen/office/dom/presentation"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { isEditable, presentationSaveEdits, runPreviewSave, type PreviewSaveDeps } from "@/features/drive/lib/previewSave.logic"
import { rangeByteSource } from "@/features/presentation/workers/presentationScope"
import { exposeRangePort, rangePortReader } from "@/lib/media/rangePort"
import { savePortStream } from "@/lib/media/savePortStream"
import { testUuid } from "@/tests/support/uuid"

// A presentation save's transport on the web side: the SDK worker's upload stream over the save port (pulled, a byte
// stream the SDK reads BYOB, ending only on the writer's commit), checked range reads for the save's copies, the
// port arm of runPreviewSave, and the commit that hands the session the saved file's range port.

const channels: MessageChannel[] = []

afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close()
		channel.port2.close()
	}
})

function channel(): MessageChannel {
	const made = new MessageChannel()

	channels.push(made)

	return made
}

const MiB = 1024 * 1024

function pattern(length: number): Uint8Array {
	const bytes = new Uint8Array(length)

	for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 3) & 0xff

	return bytes
}

// Reads a stream as the SDK does: BYOB reads of 64 KiB into its own buffer.
async function readByob(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader({ mode: "byob" })
	const parts: Uint8Array[] = []

	for (;;) {
		const { done, value } = await reader.read(new Uint8Array(64 * 1024))

		if (done) break

		parts.push(value.slice())
	}

	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index])
}

describe("save port upload stream", () => {
	it("delivers the written package to a BYOB reader and ends only on commit", async () => {
		const { port1, port2 } = channel()
		const writer = savePortWriter(port1)
		const stream = savePortStream(savePortReader(port2))
		const source = pattern(3 * MiB + 77)
		const read = readByob(stream)

		await writer.write(source)
		await writer.close()
		writer.commit()

		expect(same(await read, source)).toBe(true)
	})

	it("errors the upload stream when the writer aborts, and aborts the writer when the upload cancels", async () => {
		const first = channel()
		const writer = savePortWriter(first.port1)
		const read = readByob(savePortStream(savePortReader(first.port2)))

		await writer.write(pattern(2 * MiB))
		writer.abort("refused")

		await expect(read).rejects.toEqual(new SavePortAbortedError("refused"))

		const second = channel()
		const other = savePortWriter(second.port1)
		const stream = savePortStream(savePortReader(second.port2))

		await stream.cancel()

		expect(await other.aborted).toBe("upload")
	})
})

describe("checked range reads", () => {
	it("serves the CRC of the bytes it sends, continued from the reader's", async () => {
		const { port1, port2 } = channel()
		const bytes = pattern(10_000)

		exposeRangePort(port1, (start, end) => Promise.resolve(bytes.slice(start, end)), new AbortController(), crc32)

		const reader = rangePortReader(port2)
		const head = await reader.readChecked(0, 4000, 0, new AbortController().signal)
		const tail = await reader.readChecked(4000, 10_000, head.crc, new AbortController().signal)

		expect(same(head.bytes, bytes.subarray(0, 4000))).toBe(true)
		expect(tail.crc).toBe(crc32(bytes))
	})

	it("refuses a checked read on a port served without a checksum", async () => {
		const { port1, port2 } = channel()

		exposeRangePort(port1, (start, end) => Promise.resolve(new Uint8Array(end - start)), new AbortController())

		await expect(rangePortReader(port2).readChecked(0, 10, 0, new AbortController().signal)).rejects.toThrow("serves no checksum")
	})

	it("gives a deck opened from a checked port readChecked, straight from the port; an unchecked one none", async () => {
		const bytes = pattern(3 * MiB)
		const reads: [number, number][] = []
		const serve = (checked: boolean) => {
			const { port1, port2 } = channel()

			exposeRangePort(
				port1,
				(start, end) => {
					reads.push([start, end])

					return Promise.resolve(bytes.slice(start, end))
				},
				new AbortController(),
				crc32
			)

			return rangeByteSource({ kind: "range", port: port2, size: bytes.length, checked }, new Map())
		}

		expect("readChecked" in serve(false)).toBe(false)

		const source = serve(true)
		const read = await source.readChecked?.(MiB + 5, 100, 0)

		expect(read?.crc).toBe(crc32(bytes.subarray(MiB + 5, MiB + 105)))
		// Not through the 1 MiB block cache.
		expect(reads).toEqual([[MiB + 5, MiB + 105]])
	})
})

describe("a save's copy pass over a range port", () => {
	function served(bytes: Uint8Array, answer?: (start: number, end: number) => Uint8Array) {
		const { port1, port2 } = channel()
		const reads: [number, number][] = []
		const lifetime = new AbortController()

		exposeRangePort(
			port1,
			(start, end) => {
				reads.push([start, end])

				return Promise.resolve(answer?.(start, end) ?? bytes.slice(start, end))
			},
			lifetime,
			crc32
		)

		return { source: rangeByteSource({ kind: "range", port: port2, size: bytes.length, checked: true }, new Map()), reads, lifetime }
	}

	it("reads media through a cache of its own, so a medium never evicts the deck's blocks", async () => {
		const bytes = pattern(12 * MiB)
		const { source, reads } = served(bytes)
		// The central directory's block, as an open reads it.
		const tail = await source.read(bytes.length - 100, 100)

		expect(same(tail, bytes.subarray(bytes.length - 100))).toBe(true)

		for (let offset = 0; offset < 8 * MiB; offset += MiB) {
			const piece = await source.readMedia?.(offset, MiB)

			expect(same(piece ?? new Uint8Array(0), bytes.subarray(offset, offset + MiB))).toBe(true)
		}

		const before = reads.length

		// The deck's block is still resident: reading it again downloads nothing.
		await source.read(bytes.length - 100, 100)
		expect(reads.length).toBe(before)
	})

	it("reads each 4 MiB block of the file once, in order, checks it, and answers the bytes it downloaded", async () => {
		const bytes = pattern(10 * MiB + 321)
		const { source, reads } = served(bytes)
		const pass = source.beginCopies?.()
		// Copies as a zip writer asks for them: entries of every size, some crossing blocks, a large one in 4 MiB pieces.
		const spans: [number, number][] = [
			[0, 700],
			[700, 3 * MiB],
			[3 * MiB + 100, 4 * MiB],
			[7 * MiB + 100, 3 * MiB],
			[10 * MiB + 100, 221]
		]
		let crc = 0

		for (const [offset, length] of spans) {
			const read = await source.readChecked?.(offset, length, crc)

			expect(same(read?.bytes ?? new Uint8Array(0), bytes.subarray(offset, offset + length))).toBe(true)
			expect(read?.crc).toBe(crc32(bytes.subarray(offset, offset + length), crc))
			crc = read?.crc ?? 0
		}

		expect(reads).toEqual([
			[0, 4 * MiB],
			[4 * MiB, 8 * MiB],
			[8 * MiB, 10 * MiB + 321]
		])
		expect(pass?.end()).toBe(bytes.length)

		// After the pass, a checked read goes straight to the port again.
		await source.readChecked?.(5, 10, 0)
		expect(reads.at(-1)).toEqual([5, 15])
	})

	it("serves the writer's local-header reads of its copies from the pass's blocks, and the viewer's other reads from its cache", async () => {
		const bytes = pattern(9 * MiB)
		const { source, reads } = served(bytes)
		const pass = source.beginCopies?.()

		// The first entry's header, then its bytes; the next entry's header where they ended, and inside the block.
		expect(same(await source.read(0, 40), bytes.subarray(0, 40))).toBe(true)
		await source.readChecked?.(0, 5 * MiB, 0)
		expect(same(await source.read(5 * MiB, 40), bytes.subarray(5 * MiB, 5 * MiB + 40))).toBe(true)
		expect(same(await source.read(6 * MiB, 40), bytes.subarray(6 * MiB, 6 * MiB + 40))).toBe(true)
		// The viewer reading elsewhere meanwhile.
		expect(same(await source.read(8 * MiB + 7, 40), bytes.subarray(8 * MiB + 7, 8 * MiB + 47))).toBe(true)

		expect(reads).toEqual([
			[0, 4 * MiB],
			[4 * MiB, 8 * MiB],
			[8 * MiB, 9 * MiB]
		])
		expect(pass?.end()).toBe(8 * MiB)
	})

	it("fails a copy whose block came back short or damaged", async () => {
		const bytes = pattern(5 * MiB)
		const short = served(bytes, (start, end) => bytes.slice(start, end - (start === 0 ? 3 : 0)))

		short.source.beginCopies?.()
		await expect(short.source.readChecked?.(10, 100, 0)).rejects.toThrow("short range read")

		// The server's CRC is of the bytes it sent: damage on the way shows as a mismatch.
		const { port1, port2 } = channel()

		exposeRangePort(
			port1,
			(start, end) => Promise.resolve(bytes.slice(start, end)),
			new AbortController(),
			(chunk, crc) => crc32(chunk, crc) ^ 1
		)

		const damaged = rangeByteSource({ kind: "range", port: port2, size: bytes.length, checked: true }, new Map())

		damaged.beginCopies?.()
		await expect(damaged.readChecked?.(10, 100, 0)).rejects.toThrow("arrived damaged")
	})

	it("shuts the serving side down when a source nobody read is closed", async () => {
		const { source, reads, lifetime } = served(pattern(1000))

		source.close?.()
		await vi.waitFor(() => {
			expect(lifetime.signal.aborted).toBe(true)
		})
		expect(reads).toEqual([])
	})
})

function deckItem(name: string): DriveItem {
	const file: SdkFile = {
		uuid: testUuid("deck"),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 2_048n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: {
				name,
				mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
				modified: 1_700_000_000_000n,
				size: 2_048n,
				key: "key",
				version: 2
			}
		}
	}

	return narrowItem(file)
}

describe("presentation save on the page", () => {
	it("edits a deck, template or show and an OpenDocument presentation; a 97–2003 deck only opens", () => {
		for (const name of ["a.pptx", "a.pptm", "a.potx", "a.ppsx", "a.odp", "a.otp"])
			expect(isEditable(deckItem(name), "drive"), name).toBe(true)
		for (const name of ["a.ppt", "a.pps", "a.pot"]) expect(isEditable(deckItem(name), "drive"), name).toBe(false)
		expect(isEditable(deckItem("a.pptx"), "recents")).toBe(false)
	})

	it("uploads a port's stream through uploadFileFromPort and re-keys the listing onto the rotated uuid", async () => {
		const item = deckItem("deck.pptx")
		const saved = { ...(item.data as unknown as SdkFile), uuid: testUuid("saved") }
		const uploadFileFromPort = vi.fn<NonNullable<PreviewSaveDeps["uploadFileFromPort"]>>(() => Promise.resolve(saved))
		const patchListing = vi.fn<PreviewSaveDeps["patchListing"]>()
		const { port2 } = channel()
		const outcome = await runPreviewSave(
			{ uploadFileBytes: vi.fn(), uploadFileFromPort, patchListing, rootUuid: testUuid("root") },
			{ item, content: { port: port2 } }
		)

		expect(outcome).toMatchObject({ status: "success", item: { data: { uuid: testUuid("saved") } } })
		expect(uploadFileFromPort).toHaveBeenCalledWith(testUuid("parent"), port2, "deck.pptx", expect.stringContaining("presentation"), {})
		expect(patchListing).toHaveBeenCalledOnce()
	})

	it("fails a port save without a port upload, closing the port", async () => {
		const item = deckItem("deck.pptx")
		const { port1, port2 } = channel()
		const closed = new Promise(resolve => {
			port1.addEventListener("close", resolve)
		})
		const outcome = await runPreviewSave(
			{ uploadFileBytes: vi.fn(), patchListing: vi.fn(), rootUuid: testUuid("root") },
			{ item, content: { port: port2 } }
		)

		expect(outcome.status).toBe("error")
		port1.start()
		await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 50))])
	})

	it("commits a written save with the saved file's range port and the save's revision", async () => {
		const ports: PortLike[] = []
		const commits: unknown[] = []
		const session = {
			save: (options: { readonly port: PortLike }) => {
				ports.push(options.port)

				return Promise.resolve<SaveResult>({ kind: "written", bytes: 10, revision: 7, notices: [] })
			},
			commitSaved: (options: unknown) => {
				commits.push(options)

				return Promise.resolve({ dirty: false })
			}
		}
		const served: [MessagePort, DriveItem][] = []
		const edits = presentationSaveEdits(session, (port, file) => served.push([port, file]), true)
		const file = deckItem("deck.pptx")

		expect(edits.kind).toBe("port")
		expect(ports).toHaveLength(1)
		expect(await edits.commit(file)).toEqual({ dirty: false })
		expect(served).toHaveLength(1)
		expect(commits).toEqual([
			{ file: { uuid: testUuid("deck"), name: "deck.pptx" }, port: expect.any(MessagePort) as unknown, size: 2048, revision: 7 }
		])
	})

	it("refuses to commit a save that wrote nothing", async () => {
		const session = {
			save: () => Promise.resolve<SaveResult>({ kind: "unchanged" }),
			commitSaved: vi.fn(() => Promise.resolve({ dirty: false }))
		}
		const edits = presentationSaveEdits(session, () => undefined, false)

		await expect(edits.commit(deckItem("deck.pptx"))).rejects.toThrow("not written")
		expect(session.commitSaved).not.toHaveBeenCalled()
	})
})
