import type { AnyFile } from "@filen/sdk-rs"
import { PDF_DESKTOP_MEMORY, PDF_MOBILE_MEMORY, shouldRespawn, type PdfMemoryProfile } from "@filen/office/core/pdfedit"
import {
	PDF_ENGINE_WASM,
	PdfEngineClient,
	PdfEngineError,
	type MupdfFormat,
	type MupdfLayout,
	type PdfByteChannel,
	type PdfEngineRole,
	type PdfOpenResult,
	type PdfOpenSource
} from "@filen/office/dom/pdfedit"
import PdfEngineWorker from "@/features/pdf/workers/pdfEngine.worker.ts?worker"
import { withPdfEngineModule } from "@/features/pdf/session/engineModule"
import { openSyncRange, type SyncRangeHandle } from "@/lib/media/syncRange"
import { sdkApi } from "@/lib/sdk/client"
import { pdfMemoryConstrained } from "@/features/preview/lib/pdfLimits"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { log } from "@/lib/log"
import { transferList } from "@/lib/transferList"
import { createOwnedWorker } from "@/lib/workers/ownedWorker"
import { trackWorkerCalls } from "@/e2e-hooks/sdkCalls"
import { originKey, originSize, originWhole, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { openOriginSyncSource } from "@/features/preview/lib/origin/syncSource"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { getPreviewBytes, takePreviewBytes } from "@/features/preview/lib/previewCache"

// One PDF engine: a worker with MuPDF and one document, reading the file through its own sync range bridge from the
// SDK worker (a document of the read role read whole, an archive entry or bytes the page holds, is transferred to it
// instead). Closing it closes the document, stops the bridge and terminates the worker; a poisoned engine (a wasm
// trap, out of memory, a stuck render) is terminated at once and reports it. Every engine is an owned preview worker,
// so sign-out terminates it at once (its calls reject "closed"). Every engine holds the compiled MuPDF module
// (engineModule.ts) while it lives.

export function pdfEngineMemory(): PdfMemoryProfile {
	return pdfMemoryConstrained() ? PDF_MOBILE_MEMORY : PDF_DESKTOP_MEMORY
}

export interface PdfEngine {
	readonly client: PdfEngineClient
	readonly opened: PdfOpenResult
	// Closes the document and the worker. `heapBytes` is the engine's high-water mark, for the respawn decision of a
	// caller that reopens.
	close(): Promise<{ readonly heapBytes: number }>
}

export interface OpenPdfEngineOptions {
	readonly file: AnyFile
	readonly access: PreviewAccessMode
	readonly role: PdfEngineRole
	readonly password?: string
	// Called once if the engine is poisoned (it is already terminated then).
	readonly onPoisoned?: (message: string) => void
}

// The engine's client, and `gone`: rejects once the worker is gone (a break, sign-out, or the client's own terminate). E2E
// builds count its calls in flight (e2e-hooks/sdkCalls.ts); a normal build drops the branch.
function spawn(module: WebAssembly.Module): { readonly client: PdfEngineClient; readonly gone: Promise<never> } {
	const owned = createOwnedWorker<object>(() => new PdfEngineWorker({ name: "pdf-engine" }), "pdf-engine")
	const { worker } = owned

	worker.postMessage({ [PDF_ENGINE_WASM]: module })

	const client = new PdfEngineClient({
		postMessage: (message, transfer) => {
			worker.postMessage(message, { transfer: transferList(transfer) })
		},
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			worker.addEventListener(type, event => {
				listener({ data: event instanceof MessageEvent ? event.data : event })
			})
		},
		terminate: () => {
			owned.terminate()
		}
	})

	return {
		// Every operation goes through `call`: its first argument names it.
		client:
			import.meta.env.VITE_E2E === "1"
				? trackWorkerCalls(client, "pdf-engine", (method, args) => (method === "call" ? String(args[0]) : method))
				: client,
		gone: owned.gone
	}
}

// Where an engine reads its file: a drive file through the SDK worker, a channel another engine serves (a written
// save, from the editing engine's heap), or (the read role) a preview origin.
export type EngineSource =
	| { readonly kind: "file"; readonly file: AnyFile; readonly access: PreviewAccessMode }
	| { readonly kind: "channel"; readonly channel: PdfByteChannel }
	// `scope`: the preview cache's (previewCacheScope), where a whole origin's bytes may already be.
	| { readonly kind: "origin"; readonly origin: ByteOrigin; readonly access: OriginAccess; readonly scope: string | null }

// The read role's open: the document's format, its first layout (reflowable formats), its language when known, and the
// most source pixels one image of a drawn page may have.
export interface EngineReadArgs {
	readonly format: MupdfFormat
	readonly layout?: MupdfLayout
	readonly language?: string
	readonly maxImagePixels: number
}

export interface EngineStart {
	readonly source: EngineSource
	readonly role: PdfEngineRole
	readonly password?: string
	readonly read?: EngineReadArgs
	// Aborting before the open settles ends the engine (the open rejects).
	readonly signal?: AbortSignal
	readonly onPoisoned?: (message: string) => void
}

// A whole origin's bytes, to transfer to the engine: the preview cache's when it holds them (`cached`: they are taken out
// of it only as they are transferred, as a transfer leaves a detached view behind), else loaded without keeping them.
async function wholeOriginBytes(
	source: Extract<EngineSource, { readonly kind: "origin" }>,
	token: string,
	signal: AbortSignal | undefined
): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly cached: boolean }> {
	const { origin, access, scope } = source
	const held = getPreviewBytes(scope, originKey(origin))
	const bytes =
		held ??
		(await loadOriginBytes(origin, token, {
			access,
			cap: originSize(origin),
			store: false,
			scope,
			...(signal === undefined ? {} : { signal })
		}))

	// Only a buffer of exactly these bytes is transferred whole; a view into a larger one is copied (and the cache keeps
	// its own).
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
		? { bytes: bytes as Uint8Array<ArrayBuffer>, cached: held !== undefined }
		: { bytes: bytes.slice(), cached: false }
}

export async function startEngine(options: EngineStart): Promise<PdfEngine> {
	const token = crypto.randomUUID()
	const engineDone = Promise.withResolvers<undefined>()
	const ready = Promise.withResolvers<PdfEngine>()
	let range: SyncRangeHandle | null = null

	// The module is held until the engine closes; an open that fails releases it.
	void withPdfEngineModule(async module => {
		const { client, gone } = spawn(module)
		// An object, as the open's awaits read it after end() may have run.
		const life = { ended: false }
		const end = (): void => {
			if (life.ended) {
				return
			}

			life.ended = true
			client.terminate()
			range?.close()

			options.signal?.removeEventListener("abort", end)

			if (options.source.kind !== "channel") void sdkApi.cancelPreviewDownload(token).catch(() => undefined)

			engineDone.resolve(undefined)
		}

		// Sign-out (or a broken worker) ends the engine like a close.
		gone.catch(end)

		if (options.signal?.aborted === true) end()
		else options.signal?.addEventListener("abort", end)

		client.onPoisoned(message => {
			log.warn("pdf", "engine poisoned", { message })
			end()
			options.onPoisoned?.(message)
		})

		try {
			const { source } = options
			let opening: PdfOpenSource
			let transfer: unknown[]

			if (source.kind === "origin" && originWhole(source.origin)) {
				const { bytes, cached } = await wholeOriginBytes(source, token, options.signal)

				if (life.ended) throw new PdfEngineError("closed", "the engine was closed")

				// Out of the cache in the same task as the transfer below, now that nothing can stop it.
				if (cached) takePreviewBytes(source.scope, originKey(source.origin))

				opening = { bytes }
				transfer = [bytes.buffer]
			} else {
				if (source.kind === "file") range = await openSyncRange(source.file, source.access, token)
				else if (source.kind === "origin") range = await openOriginSyncSource(source.origin, token, { access: source.access })

				// Ended while the bridge opened: nothing reads it.
				if (life.ended) range?.close()

				const channel = range?.channel ?? (source.kind === "channel" ? source.channel : null)

				if (channel === null) throw new Error("the engine has no source")

				opening = { channel }
				transfer = [channel.port]
			}

			const opened = await client.call(
				"open",
				{
					...opening,
					role: options.role,
					...(options.password === undefined ? {} : { password: options.password }),
					// What the editor lets the document grow to in this browser, and the read role's heap budget.
					...(options.role === "edit" || options.role === "read" ? { memory: pdfEngineMemory() } : {}),
					...options.read
				},
				transfer
			)
			let closing: Promise<{ readonly heapBytes: number }> | null = null

			options.signal?.removeEventListener("abort", end)

			ready.resolve({
				client,
				opened,
				close: () => {
					closing ??= client
						.call("close", {})
						.catch(() => ({ heapBytes: 0 }))
						.then(report => {
							end()

							return report
						})

					return closing
				}
			})
		} catch (error) {
			// Ended meanwhile (aborted, signed out): whatever the step under way threw, the engine is closed.
			const closed = life.ended && !(error instanceof PdfEngineError && error.failure === "poisoned")

			end()
			ready.reject(closed ? new PdfEngineError("closed", "the engine was closed") : error)
		}

		return engineDone.promise
	}).catch((error: unknown) => {
		ready.reject(error)
	})

	return ready.promise
}

export function openPdfEngine(options: OpenPdfEngineOptions): Promise<PdfEngine> {
	return startEngine({
		source: { kind: "file", file: options.file, access: options.access },
		role: options.role,
		...(options.password === undefined ? {} : { password: options.password }),
		...(options.onPoisoned === undefined ? {} : { onPoisoned: options.onPoisoned })
	})
}

// A short-lived verifying engine on a channel another engine serves (its port is transferred to the new engine).
export function openPdfEngineOnChannel(channel: PdfByteChannel, password: string | undefined): Promise<PdfEngine> {
	return startEngine({ source: { kind: "channel", channel }, role: "verify", ...(password === undefined ? {} : { password }) })
}

// An editing engine on a channel another engine serves: a new document that engine made (extracted pages), not yet a
// file anywhere.
export function openPdfEditEngineOnChannel(
	channel: PdfByteChannel,
	password: string | undefined,
	onPoisoned: (message: string) => void
): Promise<PdfEngine> {
	return startEngine({ source: { kind: "channel", channel }, role: "edit", ...(password === undefined ? {} : { password }), onPoisoned })
}

// Whether an engine that reached `heapBytes` should be replaced by a fresh one before more work (wasm memory never
// shrinks).
export function engineNeedsRespawn(heapBytes: number): boolean {
	return shouldRespawn(heapBytes, pdfEngineMemory())
}
