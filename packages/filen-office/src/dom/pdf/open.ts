import { PdfWorkerUnavailableError, passwordReason, type PdfPasswordReason } from "./errors"
import type { PdfDocument, PdfDocumentParams, PdfJs, PdfRangeTransport } from "./types"

// Opens a document with the host's pdf.js module, worker and assets. The security-relevant parameters are set
// here, in one place, never by a caller:
// - enableXfa off: XFA is a second, scriptable form engine.
// - no docBaseUrl: a document's catalog can override it, and relative URLs inside the document resolve
//   against it.
// - no password option: passwords answer onPassword, so they never sit in the parameters.
// - verbosity ERRORS: pdf.js warnings quote document content.
// Scripting is the annotation layer's own opt-in and is never enabled; pdf.js 6 has no eval path.

export type PdfSource =
	// The whole file. Copied: pdf.js transfers the buffer it is given to its worker, detaching it.
	| { readonly kind: "bytes"; readonly bytes: Uint8Array }
	// Read on demand (a file larger than one should hold twice, or bytes behind a bridge).
	| {
			readonly kind: "ranges"
			readonly length: number
			readonly read: (offset: number, length: number) => Promise<Uint8Array>
			// The most one read asks for; pdf.js merges adjacent chunks into one request of any size.
			readonly maxRead?: number
			// How many reads of one request run at once (default 4).
			readonly readsInFlight?: number
			readonly chunkSize?: number
	  }

export type PdfWorker =
	// A dedicated Worker per document, from pdf.js's worker script (a same-origin URL).
	| { readonly kind: "script"; readonly src: string }
	// pdf.js's main-thread worker, for a page that cannot start one (an opaque origin): the host imports
	// pdf.worker.mjs statically, which installs globalThis.pdfjsWorker.
	| { readonly kind: "inThread" }

export type PdfAssetKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl"

export type PdfAssets =
	// pdf.js's defaults: system fonts for the standard 14, no cMaps or wasm decoders.
	| { readonly kind: "none" }
	// Directories pdf.js fetches from, each ending in "/".
	| {
			readonly kind: "urls"
			readonly cMapUrl?: string
			readonly standardFontDataUrl?: string
			readonly wasmUrl?: string
			readonly iccUrl?: string
	  }
	// Bytes handed over directly, nothing fetched (a page whose origin cannot fetch). The bundled standard fonts
	// are used instead of the platform's, so documents lay out alike everywhere.
	| { readonly kind: "inline"; readonly read: (kind: PdfAssetKind, filename: string) => Promise<Uint8Array> }

export interface PdfOpenOptions {
	readonly worker: PdfWorker
	readonly assets?: PdfAssets
	// Largest image decoded, in pixels; larger ones are skipped. Unset: no limit.
	readonly maxImageSize?: number
	// Largest canvas pdf.js allocates itself, in bytes. Unset: pdf.js's default.
	readonly canvasMaxAreaInBytes?: number
	// pdf.js asks for a password: answer through PdfOpening.password (pdf.js waits meanwhile).
	readonly onPassword: (reason: PdfPasswordReason) => void
	// A ranged read failed after the document opened (pdf.js never asks for a failed range again).
	readonly onReadError?: () => void
	// Every byte of a ranged source has been handed to pdf.js (it asks for each range once), which then holds the
	// whole file for the document's life. Called once.
	readonly onFullyRead?: () => void
}

export interface PdfOpening<S = unknown> {
	readonly promise: Promise<PdfDocument<S>>
	// Answers the pending password request on the same task, which already holds the file. False when none is
	// pending.
	password(password: string): boolean
	destroy(): Promise<void>
}

// Thrown into PdfOpening.promise when a ranged read fails before the document opened.
export class PdfReadError extends Error {
	override readonly name = "PdfReadError"

	constructor() {
		super("range read failed")
	}
}

const VERBOSITY_ERRORS = 0
const DEFAULT_CHUNK = 256 * 1024
const DEFAULT_READS_IN_FLIGHT = 4

// One answer per request: pdf.js matches an answer to its request by the start offset, so the reads of a request
// larger than maxRead are merged. They run in parallel, at most inFlight at once; a request one read covers is handed
// on as read, without a copy.
export async function readRange(
	read: (offset: number, length: number) => Promise<Uint8Array>,
	begin: number,
	end: number,
	maxRead: number,
	inFlight: number
): Promise<Uint8Array | null> {
	const total = end - begin

	if (total <= 0) return null

	const checked = async (offset: number, length: number): Promise<Uint8Array> => {
		const chunk = await read(offset, length)

		if (chunk.length !== length) throw new PdfReadError()

		return chunk
	}

	if (total <= maxRead) return checked(begin, total)

	const merged = new Uint8Array(total)
	let next = begin
	const lane = async (): Promise<void> => {
		while (next < end) {
			const offset = next
			const length = Math.min(maxRead, end - offset)

			next += length
			merged.set(await checked(offset, length), offset - begin)
		}
	}

	await Promise.all(Array.from({ length: Math.min(inFlight, Math.ceil(total / maxRead)) }, lane))

	return merged
}

function hasInThreadWorker(): boolean {
	const worker: unknown = Reflect.get(globalThis, "pdfjsWorker")

	return typeof worker === "object" && worker !== null && typeof Reflect.get(worker, "WorkerMessageHandler") === "function"
}

export function pdfDocumentParams(
	source: PdfSource,
	assets: PdfAssets,
	options: Pick<PdfOpenOptions, "maxImageSize" | "canvasMaxAreaInBytes">
): PdfDocumentParams {
	const params: { -readonly [K in keyof PdfDocumentParams]: PdfDocumentParams[K] } = { enableXfa: false, verbosity: VERBOSITY_ERRORS }

	if (source.kind === "bytes") params.data = source.bytes.slice()
	else {
		// Both, or neither takes effect: pdf.js would otherwise read ahead through the whole file.
		params.disableStream = true
		params.disableAutoFetch = true
		params.rangeChunkSize = source.chunkSize ?? DEFAULT_CHUNK
	}

	if (assets.kind === "urls") {
		if (assets.cMapUrl !== undefined) {
			params.cMapUrl = assets.cMapUrl
			params.cMapPacked = true
		}

		if (assets.standardFontDataUrl !== undefined) params.standardFontDataUrl = assets.standardFontDataUrl
		if (assets.wasmUrl !== undefined) params.wasmUrl = assets.wasmUrl
		if (assets.iccUrl !== undefined) params.iccUrl = assets.iccUrl
	} else if (assets.kind === "inline") {
		const read = assets.read

		// pdf.js constructs it with the asset URLs (unused: nothing is fetched) and calls fetch().
		params.BinaryDataFactory = class {
			fetch({ kind, filename }: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array> {
				return read(kind, filename)
			}
		}
		// Pinned, never inferred: pdf.js infers it from whether its asset URLs look fetchable, which differs
		// between a development server and a release build.
		params.useWorkerFetch = false
		params.useSystemFonts = false
	}

	if (options.maxImageSize !== undefined) params.maxImageSize = options.maxImageSize
	if (options.canvasMaxAreaInBytes !== undefined) params.canvasMaxAreaInBytes = options.canvasMaxAreaInBytes

	return params
}

export function openPdf<S>(pdfjs: PdfJs<S>, source: PdfSource, options: PdfOpenOptions): PdfOpening<S> {
	if (options.worker.kind === "inThread") {
		if (!hasInThreadWorker()) {
			const failed = Promise.reject(new PdfWorkerUnavailableError())

			return { promise: failed, password: () => false, destroy: () => Promise.resolve() }
		}
	} else if (pdfjs.GlobalWorkerOptions.workerSrc !== options.worker.src) {
		pdfjs.GlobalWorkerOptions.workerSrc = options.worker.src
	}

	let destroyed = false
	let opened = false
	let failRead: ((error: Error) => void) | null = null
	const readFailed = new Promise<never>((_, reject) => {
		failRead = reject
	})

	let range: PdfRangeTransport | undefined

	if (source.kind === "ranges") {
		const transport = new pdfjs.PDFDataRangeTransport(source.length, null)
		const maxRead = Math.max(1, source.maxRead ?? Number.MAX_SAFE_INTEGER)

		const inFlight = Math.max(1, source.readsInFlight ?? DEFAULT_READS_IN_FLIGHT)
		const onFullyRead = options.onFullyRead
		let loaded = 0

		transport.requestDataRange = (begin: number, end: number): void => {
			readRange(source.read, begin, end, maxRead, inFlight)
				.then(bytes => {
					if (destroyed || bytes === null) return

					// Read before handing over: pdf.js may transfer the buffer to its worker.
					const before = loaded

					loaded += bytes.length
					transport.onDataRange(begin, bytes)

					if (onFullyRead !== undefined && before < source.length && loaded >= source.length) onFullyRead()
				})
				.catch(() => {
					if (destroyed) return

					if (opened) options.onReadError?.()
					else failRead?.(new PdfReadError())
				})
		}

		range = transport
	}

	const params = pdfDocumentParams(source, options.assets ?? { kind: "none" }, options)
	const call: PdfDocumentParams = range === undefined ? params : { ...params, range }
	const task = pdfjs.getDocument(call)
	let pending: ((password: string) => void) | null = null

	task.onPassword = (update: (password: string) => void, reason: unknown): void => {
		pending = update
		options.onPassword(passwordReason(reason))
	}

	const promise = Promise.race([task.promise, readFailed]).then(document => {
		opened = true

		return document
	})

	// A failure before anyone awaits (a destroyed task) must not surface as unhandled.
	readFailed.catch(() => undefined)

	return {
		promise,
		password(password: string): boolean {
			const update = pending

			if (update === null || destroyed) return false

			pending = null
			update(password)

			return true
		},
		destroy(): Promise<void> {
			destroyed = true
			pending = null

			return task.destroy()
		}
	}
}
