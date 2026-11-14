import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import PdfSignerWorker from "@/features/pdf/workers/pdfSigner.worker.ts?worker"
import type { PdfSignerApi, PdfSignerLoadFailure, PdfSignerUnlock } from "@/features/pdf/workers/pdfSignerCore"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"

// The page side of the certificate signer: one signer worker per signing. The container goes from the drive (the SDK
// worker's range port) or from the picked device file straight into the worker, never through the page; the key is
// made and used there, and terminate() ends the worker, which is the only way the key goes away. Terminate after the
// signature is made or when the signing is cancelled.

export type PdfSignerFileSource = { readonly kind: "drive"; readonly file: AnyFile } | { readonly kind: "device"; readonly file: File }

export interface PdfSigner {
	// Never rejects: a signer that died answers "readFailed".
	unlock(password: string): Promise<PdfSignerUnlock>
	// The CMS over `digest`; rejects once terminated.
	sign(digest: Uint8Array): Promise<Uint8Array>
	terminate(): void
}

export type OpenPdfSignerResult =
	{ readonly ok: true; readonly signer: PdfSigner } | { readonly ok: false; readonly reason: PdfSignerLoadFailure }

export async function openPdfSigner(source: PdfSignerFileSource): Promise<OpenPdfSignerResult> {
	const worker = new PdfSignerWorker({ name: "pdf-signer" })
	const remote = Comlink.wrap<PdfSignerApi>(worker)
	const token = crypto.randomUUID()
	let terminated = false
	const terminate = (): void => {
		if (terminated) {
			return
		}

		terminated = true
		remote[Comlink.releaseProxy]()
		worker.terminate()

		if (source.kind === "drive") {
			void sdkApi.cancelPreviewDownload(token)
		}
	}

	let loaded: Awaited<ReturnType<PdfSignerApi["load"]>>

	try {
		if (source.kind === "drive") {
			const { port1, port2 } = new MessageChannel()

			await sdkApi.openRangePort(Comlink.transfer(port1, [port1]), source.file, token)
			loaded = await remote.load(Comlink.transfer({ kind: "port", port: port2, size: Number(source.file.size) }, [port2]))
		} else {
			loaded = await remote.load({ kind: "file", file: source.file })
		}
	} catch (error) {
		log.warn("preview", "pdf signer load failed", error)
		terminate()

		return { ok: false, reason: "readFailed" }
	}

	if (!loaded.ok) {
		terminate()

		return loaded
	}

	return {
		ok: true,
		signer: {
			unlock: password =>
				remote.unlock(password).catch((error: unknown) => {
					log.warn("preview", "pdf signer unlock failed", error)

					return { ok: false, reason: "readFailed" } as const
				}),
			sign: digest => remote.sign(digest),
			terminate
		}
	}
}
