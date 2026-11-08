import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MessageChannel, type MessagePort } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import { unzipSync, zipSync } from "fflate"
import { BytePieces, OpcPackage, bytesSource } from "@filen/office/core/opc"
import { encodeUtf8 } from "@filen/office/core/xml"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import { DocxEditorSession } from "@filen/office/core/docx/edit"
import { DocxSaveError, prepareDocxSave, saveDocx, writerProof } from "@filen/office/core/docx/write"
import type { DocxEngineServices, DocxWorkerLike } from "@filen/office/dom/docx"
import { inThreadEditingHost } from "@filen/office/dom/docx/editing"
import { DocxClosedError, DocxZipWorkerError, docxZipWorker, inThreadDocxZipper, serveDocxZipWorker } from "@filen/office/dom/docx/save"
import { nodeText, openBytes } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { ZIP_ENTRY_TIME } from "./zipTime"

// The zip half of a save behind its worker protocol: a real message channel (structured clone, transfers)
// between the page side and serveDocxZipWorker, the original file read back from the page.

const FIXTURE = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "08-large-300p.docx")))

const ports: MessagePort[] = []

afterEach(() => {
	for (const port of ports.splice(0)) port.close()
})

interface WorkerState {
	readonly terminated: () => boolean
	readonly created: () => number
	// Bytes of the buffers behind every Uint8Array that crossed, either way (a clone copies a whole buffer).
	readonly crossed: () => number
}

interface Message {
	readonly t?: unknown
	readonly bytes?: unknown
}

// Bytes a message moves: each Uint8Array in it, the whole buffer behind it.
function crossing(message: unknown, depth = 0): number {
	if (message instanceof Uint8Array) return message.buffer.byteLength
	if (typeof message !== "object" || message === null || depth > 3) return 0

	return Object.values(message).reduce<number>((sum, value) => sum + crossing(value, depth + 1), 0)
}

// A "worker" on the other end of a MessageChannel, made at the zipper's first save. `toWorker` sees (and may
// change) what the page sends; returning null swallows it (a worker that went silent).
function workerFactory(
	toWorker: (message: Message) => Message | null = message => message,
	fromWorker: (message: { readonly t?: unknown; readonly id: number; readonly offset?: unknown }) => void = () => undefined
): {
	factory: () => DocxWorkerLike
	state: WorkerState
} {
	let terminated = false
	let created = 0
	let crossed = 0
	const state: WorkerState = { terminated: () => terminated, created: () => created, crossed: () => crossed }
	const factory = (): DocxWorkerLike => {
		const { port1, port2 } = new MessageChannel()

		created++
		ports.push(port1, port2)
		serveDocxZipWorker({
			post: (message, transfer) => {
				crossed += crossing(message)
				fromWorker(message as { readonly t?: unknown; readonly id: number; readonly offset?: unknown })
				port2.postMessage(message, [...transfer])
			},
			listen: onMessage => {
				port2.on("message", (message: Message) => {
					crossed += crossing(message)

					const seen = toWorker(message)

					if (seen !== null) onMessage(seen)
				})
			}
		})

		return {
			post: (message, transfer) => {
				port1.postMessage(message, [...transfer])
			},
			listen: onMessage => {
				port1.on("message", onMessage)
			},
			terminate: () => {
				terminated = true
				port1.close()
				port2.close()
			}
		}
	}

	return { factory, state }
}

async function edited(bytes: Uint8Array, text = "Edited ") {
	const opened = await openBytes(bytes)
	// Saves compared byte for byte stamp the same core properties time.
	opened.context.identity.now = () => Date.UTC(2026, 0, 1)
	const session = new DocxEditorSession(opened.context)
	let at = -1

	session.state.doc.descendants((node, pos) => {
		if (at < 0 && node.isTextblock && node.content.size > 0) at = pos + 1

		return at < 0
	})
	session.dispatch(session.state.tr.insertText(text, at))

	return { ...opened, session, input: { pkg: opened.pkg, context: opened.context, sessions: [session] } }
}

describe("docx zip worker", () => {
	it("writes the same file as the in-thread save, reading the rewritten part from its pieces", async () => {
		const { pkg, input } = await edited(FIXTURE)
		const expected = await saveDocx(input)
		const prepared = await prepareDocxSave(input)
		const { factory, state } = workerFactory()
		const zipper = docxZipWorker(factory)(pkg.opc)
		const part = prepared.replace[0]?.bytes

		// Never joined on this side: views of the source part plus the new markup.
		expect(part).toBeInstanceOf(BytePieces)
		expect(part?.length).toBeGreaterThan(1_000_000)

		const zipped = await zipper.zip(prepared)

		expect(zipped.bytes).toEqual(expected.bytes)
		expect(zipped.changedParts).toEqual(expected.changedParts)

		// A second save reuses the worker and the archive it opened.
		expect((await zipper.zip(await prepareDocxSave(input))).bytes).toEqual(expected.bytes)
		expect(state.created()).toBe(1)
		zipper.dispose()
		expect(state.terminated()).toBe(true)
	})

	it("moves about what the save needs across, once: the part and the original's entries", async () => {
		const { pkg, input } = await edited(FIXTURE)
		const prepared = await prepareDocxSave(input)
		const { factory, state } = workerFactory()
		const zipper = docxZipWorker(factory)(pkg.opc)
		const zipped = await zipper.zip(prepared)
		const part = prepared.replace.reduce((sum, change) => sum + change.bytes.length, 0)
		const payload = part + FIXTURE.length + zipped.bytes.length

		expect(state.crossed()).toBeGreaterThan(part)
		expect(state.crossed()).toBeLessThan(payload * 1.05 + 64 * 1024)
		zipper.dispose()
	})

	it("refuses a part that changed on its way to the worker", async () => {
		const { pkg, input } = await edited(FIXTURE)
		const prepared = await prepareDocxSave(input)
		let flipped = false
		const { factory } = workerFactory(message => {
			const bytes = message.bytes

			// The first piece of the rewritten part (pieces answer the worker's "piece" reads).
			if (!flipped && message.t === "read" && bytes instanceof Uint8Array && bytes.length > 100_000) {
				bytes[1000] = (bytes[1000] ?? 0) ^ 1
				flipped = true
			}

			return message
		})
		const zipper = docxZipWorker(factory)(pkg.opc)

		await expect(zipper.zip(prepared)).rejects.toMatchObject({ reason: "untouchedChanged" })
		expect(flipped).toBe(true)
		zipper.dispose()
	})

	it("ends a worker that stops answering, and starts another for the next save", async () => {
		const { pkg, input } = await edited(FIXTURE)
		let silent = true
		const { factory, state } = workerFactory(message => (silent ? null : message))
		const zipper = docxZipWorker(factory, { stallMs: 100 })(pkg.opc)

		await expect(zipper.zip(await prepareDocxSave(input))).rejects.toBeInstanceOf(DocxZipWorkerError)
		expect(state.terminated()).toBe(true)

		silent = false

		const zipped = await zipper.zip(await prepareDocxSave(input))

		expect(zipped.bytes.length).toBeGreaterThan(0)
		expect(state.created()).toBe(2)
		zipper.dispose()
	})

	it("matches the in-thread zipper", async () => {
		const { pkg, input } = await edited(FIXTURE)
		const prepared = await prepareDocxSave(input)
		const inThread = await inThreadDocxZipper(pkg.opc).zip(prepared)
		const { factory } = workerFactory()
		const zipper = docxZipWorker(factory)(pkg.opc)

		expect((await zipper.zip(await prepareDocxSave(input))).bytes).toEqual(inThread.bytes)
		zipper.dispose()
	})

	// A copied (untouched) entry's bytes damaged on their way to the worker: its local header's time or CRC
	// field, or its data (each copy read carries the page's own checksum of what it sent).
	it.each([
		["local header time", 10],
		["local header CRC", 14],
		["data", -2]
	])("refuses with gate 2's reason when a copied entry's %s arrives damaged", async (_what, index) => {
		const { pkg, input } = await edited(FIXTURE)
		const prepared = await prepareDocxSave(input)
		let flipped = false
		const { factory } = workerFactory(message => {
			const bytes = message.bytes
			const checked = typeof (message as { readonly crc?: unknown }).crc === "number"

			if (!flipped && message.t === "read" && checked && bytes instanceof Uint8Array && bytes.length > 64) {
				const at = index < 0 ? bytes.length + index : index

				bytes[at] = (bytes[at] ?? 0) ^ 1
				flipped = true
			}

			return message
		})
		const zipper = docxZipWorker(factory)(pkg.opc)

		await expect(zipper.zip(prepared)).rejects.toMatchObject({ reason: "untouchedChanged" })
		expect(flipped).toBe(true)
		zipper.dispose()
	})

	// Reads that are not copies (the end record, the central directory) damaged on their way: every read of the
	// original carries the page's checksum of what it sent.
	it.each([
		["the end record", "end"],
		["the central directory", "directory"]
	])("refuses when %s arrives damaged", async (_what, which) => {
		const { pkg, input } = await edited(FIXTURE)
		const prepared = await prepareDocxSave(input)
		const end = FIXTURE.length - 22
		const directory =
			(FIXTURE[end + 16] ?? 0) | ((FIXTURE[end + 17] ?? 0) << 8) | ((FIXTURE[end + 18] ?? 0) << 16) | ((FIXTURE[end + 19] ?? 0) << 24)
		const asked = new Map<number, number>()
		let flipped = false
		const { factory } = workerFactory(
			message => {
				const bytes = message.bytes
				const offset = asked.get((message as { readonly id?: number }).id ?? -1)

				if (!flipped && message.t === "read" && bytes instanceof Uint8Array && offset !== undefined) {
					// The end record sits at the end of the first (tail) read; the directory read starts at its offset.
					const at =
						which === "end" && offset + bytes.length === FIXTURE.length
							? bytes.length - 10
							: which === "directory" && offset === directory
								? 38
								: -1

					if (at >= 0) {
						bytes[at] = (bytes[at] ?? 0) ^ 1
						flipped = true
					}
				}

				return message
			},
			request => {
				if (request.t === "read" && typeof request.offset === "number") asked.set(request.id, request.offset)
			}
		)
		const zipper = docxZipWorker(factory)(pkg.opc)

		await expect(zipper.zip(prepared)).rejects.toMatchObject({ reason: "untouchedChanged" })
		expect(flipped).toBe(true)
		zipper.dispose()
	})

	it("saves a document whose untouched entries it cannot decode, copied as they are", async () => {
		const files = unzipSync(FIXTURE)
		// A stored entry whose recorded CRC is wrong (readers that check it refuse it; the save leaves it be).
		const archive = zipSync(
			{ ...files, "word/media/odd.bin": [encodeUtf8("x".repeat(200) + "y".repeat(200)), { level: 0 }] },
			{ mtime: ZIP_ENTRY_TIME }
		)
		const name = encodeUtf8("word/media/odd.bin")
		let local = -1

		for (let i = 0; i < archive.length - 30 && local < 0; i++) {
			if (archive[i] === 0x50 && archive[i + 1] === 0x4b && archive[i + 2] === 3 && archive[i + 3] === 4) {
				const length = (archive[i + 26] ?? 0) | ((archive[i + 27] ?? 0) << 8)

				if (length === name.length && name.every((byte, k) => archive[i + 30 + k] === byte)) local = i
			}
		}

		const damaged = archive.slice()

		damaged[local + 30 + name.length + 100] = (damaged[local + 30 + name.length + 100] ?? 0) ^ 1

		const { pkg, input } = await edited(damaged)
		const prepared = await prepareDocxSave(input)
		const { factory } = workerFactory()
		const zipper = docxZipWorker(factory)(pkg.opc)
		const zipped = await zipper.zip(prepared)
		const written = await OpcPackage.open(bytesSource(zipped.bytes))
		const entry = written.zip.entries.find(candidate => candidate.name === "word/media/odd.bin")
		const before = pkg.opc.zip.entries.find(candidate => candidate.name === "word/media/odd.bin")

		if (entry === undefined || before === undefined) throw new Error("no entry")

		expect(await written.zip.raw(entry)).toEqual(await pkg.opc.zip.raw(before))
		zipper.dispose()
	})

	it("passes a change the archive cannot take on as a refusal", async () => {
		const { pkg } = await edited(FIXTURE)
		const { factory } = workerFactory()
		const zipper = docxZipWorker(factory)(pkg.opc)
		const error = await zipper.zip({ replace: [{ name: "word/missing.xml", bytes: new Uint8Array(4) }], add: [] }).then(
			() => null,
			(failure: unknown) => failure
		)

		expect(error).toBeInstanceOf(DocxSaveError)
		expect(error).toMatchObject({ reason: "invalidPackage", message: "No part word/missing.xml to replace" })
		zipper.dispose()
	})

	it("takes out the parts a save removes, as the in-thread zipper does", async () => {
		const bytes = buildDocx({ body: p("Text"), parts: [{ name: "word/media/unused.png", data: new Uint8Array([1, 2, 3]) }] })
		const original = await OpcPackage.open(bytesSource(bytes))
		const { factory } = workerFactory()
		const zipper = docxZipWorker(factory)(original)
		const changes = { replace: [], add: [], remove: ["word/media/unused.png"] }
		const zipped = await zipper.zip(changes)
		const local = await inThreadDocxZipper(original).zip(changes)

		expect(zipped.bytes).toEqual(local.bytes)
		expect(Object.keys(unzipSync(zipped.bytes)).filter(name => name.includes("unused"))).toEqual([])
		expect(Object.keys(unzipSync(zipped.bytes))).toEqual(Object.keys(unzipSync(bytes)).filter(name => !name.includes("unused")))
		zipper.dispose()
	})

	it("rejects a zip under way when disposed, and every later one", async () => {
		const { pkg, input } = await edited(FIXTURE)
		const prepared = await prepareDocxSave(input)
		const { factory, state } = workerFactory()
		const zipper = docxZipWorker(factory)(pkg.opc)
		const pending = zipper.zip(prepared)

		zipper.dispose()
		await expect(pending).rejects.toBeInstanceOf(DocxClosedError)
		expect(state.terminated()).toBe(true)
		await expect(zipper.zip(await prepareDocxSave(input))).rejects.toBeInstanceOf(DocxClosedError)
	})
})

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

function services(onYield: () => void = () => undefined): DocxEngineServices {
	// Every slice gives a (microtask) turn.
	return {
		fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
		replayFonts: false,
		fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
		measurer,
		yield: () => {
			onYield()

			return Promise.resolve()
		},
		sliceMs: 0
	}
}

describe("editing host saves", () => {
	it("writes in slices on this thread and zips in the worker", async () => {
		const { factory, state } = workerFactory()
		const editing = inThreadEditingHost(() => services(), {
			proof: writerProof,
			writer: { prepare: prepareDocxSave, zipper: docxZipWorker(factory) }
		})
		const document = editing.host(bytesSource(buildDocx({ body: p("Hello world") + p("Second") })), () => undefined)
		const editor = await editing.editor

		editor.session.dispatch(editor.session.state.tr.insertText("Saved ", 1))

		const written = await editing.save()
		const reopened = await openBytes(written.bytes)

		expect(nodeText(new DocxEditorSession(reopened.context).state.doc.child(0))).toBe("Saved Hello world")
		expect(written.changedParts).toContain("word/document.xml")
		expect(state.created()).toBe(1)
		document.close()
		expect(state.terminated()).toBe(true)
	})

	it("stops a save under way when the document closes", async () => {
		const { factory } = workerFactory()
		let close: () => void = () => undefined
		let yields = 0
		const editing = inThreadEditingHost(
			() =>
				services(() => {
					// Closed between two slices of the save.
					if (++yields === 3) close()
				}),
			{ writer: { prepare: prepareDocxSave, zipper: docxZipWorker(factory) } }
		)
		const body = Array.from({ length: 400 }, (_, k) => p(`Paragraph ${k} of a document long enough to save in slices`)).join("")
		const document = editing.host(bytesSource(buildDocx({ body })), () => undefined)
		const editor = await editing.editor

		close = () => document.close()
		editor.session.dispatch(editor.session.state.tr.insertText("Edit ", 2))
		yields = 0
		await expect(editing.save()).rejects.toBeInstanceOf(DocxClosedError)
	})

	it("refuses with the writer's DocxSaveError, nothing zipped", async () => {
		const { factory, state } = workerFactory()
		const editing = inThreadEditingHost(() => services(), {
			writer: {
				prepare: () => Promise.reject(new DocxSaveError("content", "refused")),
				zipper: docxZipWorker(factory)
			}
		})
		const document = editing.host(bytesSource(buildDocx({ body: p("Hello") })), () => undefined)

		await editing.editor
		await expect(editing.save()).rejects.toMatchObject({ reason: "content" })
		expect(state.created()).toBe(0)
		document.close()
	})
})
