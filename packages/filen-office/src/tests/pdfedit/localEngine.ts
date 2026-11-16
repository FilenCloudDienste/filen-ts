import * as mupdf from "mupdf"
import { PdfEngineClient } from "../../dom/pdfedit/client"
import type { MupdfModule, PdfBitmapLike } from "../../dom/pdfedit/protocol"
import { servePdfEngine, type PdfEngineScope, type PdfEngineServeOptions } from "../../dom/pdfedit/server"

// An engine served on the test's own thread, its messages delivered synchronously: several calls made in one go reach
// the server before any of them runs (what the queue does with them is observable). Only for documents opened from
// their whole bytes (a sync range reader would block this thread). Every test's MuPDF heap is the same one.

const running: PdfEngineClient[] = []

export function localEngine(options: Partial<PdfEngineServeOptions> = {}, module: MupdfModule = mupdf): PdfEngineClient {
	const toServer = new Set<(event: { readonly data: unknown }) => void>()
	const toClient = new Set<(event: { readonly data: unknown }) => void>()
	const scope: PdfEngineScope = {
		postMessage: message => {
			for (const listener of toClient) listener({ data: message })
		},
		addEventListener: (_type, listener) => {
			toServer.add(listener)
		},
		removeEventListener: (_type, listener) => {
			toServer.delete(listener)
		}
	}
	const stop = servePdfEngine(module, scope, {
		readDeadlineMs: 60_000,
		now: () => performance.now(),
		toBitmap: (rgba, width, height) => Promise.resolve({ width, height, rgba, close: () => undefined } as unknown as PdfBitmapLike),
		...options
	})
	const client = new PdfEngineClient({
		postMessage: message => {
			for (const listener of toServer) listener({ data: message })
		},
		addEventListener: (type: "message" | "error", listener: (event: { readonly data: unknown }) => void) => {
			if (type === "message") toClient.add(listener)
		},
		terminate: stop
	})

	running.push(client)

	return client
}

export function stopLocalEngines(): void {
	for (const client of running.splice(0)) client.terminate()
}
