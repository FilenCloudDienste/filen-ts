import type { AnyFile } from "@filen/sdk-rs"
import { PDF_DESKTOP_MEMORY, PDF_MOBILE_MEMORY, shouldRespawn, type PdfMemoryProfile } from "@filen/office/core/pdfedit"
import { PDF_ENGINE_WASM, PdfEngineClient, type PdfByteChannel, type PdfEngineRole, type PdfOpenResult } from "@filen/office/dom/pdfedit"
import PdfEngineWorker from "@/features/pdf/workers/pdfEngine.worker.ts?worker"
import { withPdfEngineModule } from "@/features/pdf/session/engineModule"
import { openSyncRange, type SyncRangeHandle } from "@/lib/media/syncRange"
import { sdkApi } from "@/lib/sdk/client"
import { pdfMemoryConstrained } from "@/features/preview/lib/pdfLimits"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { log } from "@/lib/log"

// One PDF engine: a worker with MuPDF and one document, reading the file through its own sync range bridge from the
// SDK worker. Closing it closes the document, stops the bridge and terminates the worker; a poisoned engine (a wasm
// trap, out of memory, a stuck render) is terminated at once and reports it. Every engine holds the compiled MuPDF
// module (engineModule.ts) while it lives.

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

function spawn(module: WebAssembly.Module): PdfEngineClient {
	const worker = new PdfEngineWorker({ name: "pdf-engine" })

	worker.postMessage({ [PDF_ENGINE_WASM]: module })

	return new PdfEngineClient({
		postMessage: (message, transfer) => {
			worker.postMessage(message, { transfer: transfer as Transferable[] })
		},
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			worker.addEventListener(type, event => {
				listener({ data: event instanceof MessageEvent ? event.data : event })
			})
		},
		terminate: () => {
			worker.terminate()
		}
	})
}

// Where an engine reads its file: a drive file through the SDK worker, or a channel another engine serves (a written
// save, from the editing engine's heap).
type EngineSource =
	| { readonly kind: "file"; readonly file: AnyFile; readonly access: PreviewAccessMode }
	| { readonly kind: "channel"; readonly channel: PdfByteChannel }

interface EngineStart {
	readonly source: EngineSource
	readonly role: PdfEngineRole
	readonly password?: string
	readonly onPoisoned?: (message: string) => void
}

async function startEngine(options: EngineStart): Promise<PdfEngine> {
	const token = crypto.randomUUID()
	const engineDone = Promise.withResolvers<undefined>()
	const ready = Promise.withResolvers<PdfEngine>()
	let range: SyncRangeHandle | null = null

	// The module is held until the engine closes; an open that fails releases it.
	void withPdfEngineModule(async module => {
		const client = spawn(module)
		const end = (): void => {
			client.terminate()
			range?.close()

			if (options.source.kind === "file") void sdkApi.cancelPreviewDownload(token).catch(() => undefined)

			engineDone.resolve(undefined)
		}

		client.onPoisoned(message => {
			log.warn("pdf", "engine poisoned", { message })
			end()
			options.onPoisoned?.(message)
		})

		try {
			let channel: PdfByteChannel

			if (options.source.kind === "file") {
				range = await openSyncRange(options.source.file, options.source.access, token)
				channel = range.channel
			} else channel = options.source.channel

			const opened = await client.call(
				"open",
				{ channel, role: options.role, ...(options.password === undefined ? {} : { password: options.password }) },
				[channel.port]
			)
			let closing: Promise<{ readonly heapBytes: number }> | null = null

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
			end()
			ready.reject(error)
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

// Whether an engine that reached `heapBytes` should be replaced by a fresh one before more work (wasm memory never
// shrinks).
export function engineNeedsRespawn(heapBytes: number): boolean {
	return shouldRespawn(heapBytes, pdfEngineMemory())
}
