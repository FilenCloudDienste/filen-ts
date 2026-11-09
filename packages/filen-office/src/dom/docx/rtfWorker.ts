import type { Slicing } from "../../core/slicing"
import { isRtf, type RtfPreservedKind, type RtfReadResult } from "../../core/rtf/reader"
import { RtfWriteRefusal } from "../../core/rtf/write/out"
import { RtfAborted, openRtfSource, proveRtf, writeRtf, type RtfTurns } from "../../core/rtf/write/writer"
import type { DocxGateReason } from "../../core/docx/package"
import { odtGate } from "../../core/odt/open"
import { openOdtSource } from "../../core/odt/write/source"
import { OdtWriteRefusal, proveOdt, writeOdt } from "../../core/odt/write/writer"
import type { DocxEngineServices } from "./engine"
import { inThreadDocxHost, macrotaskYield } from "./host"
import { heldSource } from "./protection"
import type { DocxOpenOptions } from "./protocol"
import { DocxRtfRefusal, type DocxRtf, type DocxRtfEdits, type DocxRtfSaved, type RtfLockedBlock } from "./rtf"
import { BytePieces, OpcPackage, bytesSource, memorySink, writeZip } from "../../core/opc/index"
import { nativeDeflate } from "../../core/docx/write/zip"
import { convertOdtEditToDocx, type TextConversion } from "../../core/convert/text/index"
import { TextConversionError } from "../../core/convert/text/report"
import { odtTranslationToDocx, rtfLossy } from "../../core/convert/text/toDocx"
import { answerOf } from "./convert"

// The RTF and OpenDocument text documents held where the engine runs: each one's source, read once into its
// translation (the reader keeps every block's source range), proved on request and written back on each save in its
// own format. A document's requests run in turn, in slices: closing it ends the one running (RtfAborted) and those
// still queued.

// A document format the server reads and writes losslessly.
export type DocxSourceFormat = "rtf" | "odt"

// A held document as its format's reader and writer see it.
interface SourceDocument {
	// The translation's package.
	readonly docx: Uint8Array
	// What the file shows that the package leaves out (a drawing object, an undrawn shape, a picture no reader takes...), counted.
	readonly untranslated: number
	// What makes the document view-only that the package does not say (a signed ODT: odtGate).
	readonly gate: readonly DocxGateReason[]
	prove(turns: RtfTurns): Promise<readonly RtfLockedBlock[]>
	// The file as edited; `bytes` is the source itself for an untouched one.
	write(edits: DocxRtfEdits, turns: RtfTurns): Promise<DocxRtfSaved>
	// The document as edited converted to .docx: its package with the edits, never through its own writer.
	convertEdited?(edits: DocxRtfEdits, turns: RtfTurns): Promise<TextConversion>
	readonly bytes: Uint8Array
}

// The translation package with the docx writer's parts in it: replaced where the package has them, added otherwise.
async function editedPackage(docx: Uint8Array, edits: DocxRtfEdits): Promise<Uint8Array> {
	const pkg = await OpcPackage.open(bytesSource(docx))
	const changes = edits.parts.map(([name, bytes]) => ({ name, bytes: BytePieces.of([bytes]) }))
	const plan = await pkg.plan({
		replace: changes.filter(change => pkg.has(change.name)),
		add: changes.filter(change => !pkg.has(change.name)),
		remove: edits.removed.filter(name => pkg.has(name))
	})
	const sink = memorySink()
	const deflate = nativeDeflate()

	await writeZip(plan, pkg.zip, sink, deflate === undefined ? {} : { deflate })

	return sink.bytes()
}

// What an RTF file shows that its pages, as the package draws them, leave out: shapes and objects drawn nowhere
// (RtfReadResult.undrawn), drawing objects, pictures in formats no reader takes, groups nested too deep, and text in
// code pages the platform cannot decode. Not counted: what the package draws another way (a shape's picture or preset
// geometry, a text box's text as paragraphs, WordArt, an equation as Office Math, an object's result, a form field's
// result), state words the text is shown under, and what no page shows (unknown destinations, bytes past the end,
// groups left open).
const UNDRAWN: ReadonlySet<RtfPreservedKind> = new Set<RtfPreservedKind>(["drawingObject", "picture", "tooDeep"])

function undrawn(read: RtfReadResult): number {
	let count = read.undrawn + read.unsupportedCodepages.length + (read.truncatedBinary ? 1 : 0)

	for (const preserved of read.preserved) if (UNDRAWN.has(preserved.kind)) count++

	return count
}

async function openSource(format: DocxSourceFormat, bytes: Uint8Array, turns: RtfTurns): Promise<SourceDocument | undefined> {
	if (format === "rtf") {
		if (!isRtf(bytes)) return undefined

		const source = await openRtfSource(bytes, turns)

		return source === undefined
			? undefined
			: {
					docx: source.read.docx,
					untranslated: undrawn(source.read),
					gate: [],
					bytes: source.bytes,
					prove: async proofTurns => (await proveRtf(source, proofTurns)).locked.map(({ part, offset }) => ({ part, offset })),
					write: async (edits, writeTurns) => ({
						bytes: (await writeRtf(source, { parts: new Map(edits.parts), removed: edits.removed }, { turns: writeTurns }))
							.bytes
					}),
					convertEdited: async (edits, convertTurns) => {
						try {
							const converted = await odtTranslationToDocx(await editedPackage(source.read.docx, edits), {
								turns: convertTurns
							})
							const lossy = rtfLossy(source.read)

							for (const { kind, count } of converted.lossy.report("rtf", "docx").features) lossy.add(kind, count)

							return { ok: true, bytes: converted.bytes, lossy: lossy.report("rtf", "docx") }
						} catch (error) {
							if (error instanceof TextConversionError) return { ok: false, refusal: error.refusal }

							throw error
						}
					}
				}
	}

	const opened = await openOdtSource(bytes, turns)

	if (!opened.ok) return undefined

	const source = opened.source

	return {
		docx: source.docx,
		// The engine lays out the same translation an ODT file is shown and exported as.
		untranslated: 0,
		// Opened view-only and saved only as a new file: an edit saved in place would leave its signatures invalid.
		gate: odtGate(source.translation.facts),
		bytes: source.bytes,
		prove: async proofTurns => (await proveOdt(source, proofTurns)).locked,
		write: async (edits, writeTurns) => {
			const written = await writeOdt(source, { parts: new Map(edits.parts), removed: edits.removed }, { turns: writeTurns })

			return {
				bytes: written.bytes,
				...(written.notices === undefined || written.notices.length === 0 ? {} : { notices: written.notices })
			}
		},
		convertEdited: async (edits, convertTurns) => convertOdtEditToDocx(await editedPackage(source.docx, edits), { turns: convertTurns })
	}
}

export type DocxRtfOpened =
	| { readonly ok: true; readonly size: number; readonly untranslated: number; readonly gate: readonly DocxGateReason[] }
	| { readonly ok: false; readonly notRtf: boolean }

export type DocxRtfWritten =
	({ readonly ok: true } & DocxRtfSaved) | { readonly ok: false; readonly reason: string; readonly message: string }

export interface DocxRtfServer {
	open(id: number, bytes: Uint8Array, format?: DocxSourceFormat): Promise<DocxRtfOpened>
	// The translation of an open document, for an engine session opened on it.
	package(id: number): Uint8Array | undefined
	// What makes an open document view-only that its translation does not say, for an engine session opened on it.
	gate(id: number): readonly DocxGateReason[] | undefined
	take(id: number): Uint8Array
	prove(id: number): Promise<readonly RtfLockedBlock[]>
	write(id: number, edits: DocxRtfEdits): Promise<DocxRtfWritten>
	// The document as edited converted to .docx; `call` names the request for abort().
	convertEdited(id: number, call: number, edits: DocxRtfEdits): Promise<TextConversion>
	// Ends a convertEdited request at its next slice.
	abort(id: number, call: number): void
	// Drops a held document; false when `id` is not one.
	close(id: number): boolean
}

interface Held {
	source: SourceDocument | undefined
	queue: Promise<unknown>
	readonly turns: RtfTurns
	closed: boolean
}

// One macrotask turn for every server of the realm (a channel each would stay open).
let realmSlicing: Slicing | undefined

// `slicing`: how proofs and writes give the thread back (default a macrotask turn every 12 ms).
export function docxRtfServer(slicing?: Slicing): DocxRtfServer {
	const held = new Map<number, Held>()
	// convertEdited requests by "<document>:<call>", aborted by the page.
	const requests = new Map<string, { aborted: boolean }>()
	const slices = slicing ?? (realmSlicing ??= { pause: macrotaskYield(), sliceMs: 12, now: () => Date.now() })
	const holding = (): Held => {
		const document: Held = {
			source: undefined,
			queue: Promise.resolve(),
			turns: {
				signal: {
					get aborted() {
						return document.closed
					}
				},
				slicing: slices
			},
			closed: false
		}

		return document
	}
	// Runs `task` after the document's earlier requests.
	const inTurn = <T>(id: number, task: (document: Held) => Promise<T>): Promise<T> => {
		const document = held.get(id)

		if (document === undefined) return Promise.reject(new Error("The document is not open"))

		const run = document.queue.then(() => (document.closed ? Promise.reject(new RtfAborted()) : task(document)))

		document.queue = run.catch(() => undefined)

		return run
	}
	const sourceOf = (document: Held): SourceDocument => {
		if (document.source === undefined) throw new Error("The document did not open")

		return document.source
	}

	return {
		async open(id, bytes, format = "rtf") {
			if (format === "rtf" && !isRtf(bytes)) return { ok: false, notRtf: true }

			const opening = holding()

			held.set(id, opening)

			let source: SourceDocument | undefined

			try {
				source = await openSource(format, bytes, opening.turns)
			} catch (error) {
				if (!(error instanceof RtfAborted)) throw error
			}

			// Closed while reading (the read ended at its next slice): nothing is kept.
			if (opening.closed || source === undefined) {
				if (held.get(id) === opening) held.delete(id)

				return { ok: false, notRtf: !opening.closed }
			}

			const document = opening

			document.source = source

			return { ok: true, size: source.docx.length, untranslated: source.untranslated, gate: source.gate }
		},
		package(id) {
			return held.get(id)?.source?.docx
		},
		gate(id) {
			return held.get(id)?.source?.gate
		},
		take(id) {
			const document = held.get(id)

			if (document === undefined) throw new Error("The document is not open")

			// The reader's package is already deflated; the copy crosses to the page, the held one stays.
			return sourceOf(document).docx.slice()
		},
		prove(id) {
			return inTurn(id, async document => sourceOf(document).prove(document.turns))
		},
		write(id, edits) {
			return inTurn(id, async document => {
				const source = sourceOf(document)

				try {
					const written = await source.write(edits, document.turns)

					// An untouched file is the source itself: a copy goes, the source stays.
					return { ...written, ok: true, bytes: written.bytes === source.bytes ? written.bytes.slice() : written.bytes }
				} catch (error) {
					if (error instanceof RtfWriteRefusal || error instanceof OdtWriteRefusal)
						return { ok: false, reason: error.reason, message: error.message }

					throw error
				}
			})
		},
		convertEdited(id, call, edits) {
			const request = { aborted: false }

			requests.set(`${String(id)}:${String(call)}`, request)

			return inTurn(id, async (document): Promise<TextConversion> => {
				const source = sourceOf(document)

				if (source.convertEdited === undefined)
					return { ok: false, refusal: { reason: "unsupported", message: "This document does not convert as edited" } }

				if (request.aborted) return { ok: false, refusal: { reason: "aborted", message: "aborted" } }

				return source.convertEdited(edits, {
					signal: {
						get aborted() {
							return document.closed || request.aborted
						}
					},
					slicing: document.turns.slicing
				})
			}).finally(() => requests.delete(`${String(id)}:${String(call)}`))
		},
		abort(id, call) {
			const request = requests.get(`${String(id)}:${String(call)}`)

			if (request !== undefined) request.aborted = true
		},
		close(id) {
			const document = held.get(id)

			if (document === undefined) return false

			document.closed = true

			return held.delete(id)
		}
	}
}

// The same on the calling thread (tests, a host without workers).
export function inThreadDocxRtf(services: (options: DocxOpenOptions) => DocxEngineServices, format: DocxSourceFormat = "rtf"): DocxRtf {
	return {
		async open(bytes, options = {}) {
			if (options.signal?.aborted === true) return { kind: "aborted" }

			const server = docxRtfServer()
			const opened = await server.open(0, bytes.slice(), format)

			if (!opened.ok) return opened.notRtf ? { kind: "notRtf" } : { kind: "aborted" }

			const engines = inThreadDocxHost(services, opened.gate)

			return {
				kind: "opened",
				document: {
					host: (_source, listener, openOptions) =>
						engines(bytesSource(server.package(0) ?? new Uint8Array(0)), listener, openOptions),
					bytes: heldSource(opened.size),
					untranslated: opened.untranslated,
					gate: opened.gate,
					take: () => Promise.resolve(server.take(0)),
					prove: () => server.prove(0),
					async write(edits) {
						const written = await server.write(0, edits)

						if (!written.ok) throw new DocxRtfRefusal(written.reason, written.message)

						return written
					},
					async convertEdited(edits, convertOptions = {}) {
						if (convertOptions.signal?.aborted === true) return { kind: "aborted" }

						return answerOf(await server.convertEdited(0, 0, edits))
					},
					release: () => {
						server.close(0)
					}
				}
			}
		}
	}
}
