import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import PdfSignerWorker from "@/features/pdf/workers/pdfSigner.worker.ts?worker"
import PdfSignerLegacyWorker from "@/features/pdf/workers/pdfSignerLegacy.worker.ts?worker"
import type { PdfSignerApi, PdfSignerLoadFailure, PdfSignerUnlock } from "@/features/pdf/workers/pdfSignerCore"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"

// The page side of the certificate signer: one signer worker per signing. The container goes from the drive (the SDK
// worker's range port) or from the picked device file straight into the worker, never through the page; the key is
// made and used there, and terminate() ends the worker, which is the only way the key goes away. Terminate after the
// signature is made or when the signing is cancelled. A container the signer cannot decrypt without node-forge's legacy
// ciphers (it answers "algorithm") is read again by the legacy signer, which then takes the first one's place.

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

interface SignerWorker {
	readonly remote: Comlink.Remote<PdfSignerApi>
	stop(): void
}

function startSigner(legacy: boolean): SignerWorker {
	const worker = legacy ? new PdfSignerLegacyWorker({ name: "pdf-signer-legacy" }) : new PdfSignerWorker({ name: "pdf-signer" })
	const remote = Comlink.wrap<PdfSignerApi>(worker)

	return {
		remote,
		stop: () => {
			remote[Comlink.releaseProxy]()
			worker.terminate()
		}
	}
}

async function loadSigner(
	signer: SignerWorker,
	source: PdfSignerFileSource,
	token: string
): Promise<Awaited<ReturnType<PdfSignerApi["load"]>>> {
	try {
		if (source.kind === "drive") {
			const { port1, port2 } = new MessageChannel()

			await sdkApi.openRangePort(Comlink.transfer(port1, [port1]), source.file, token)

			return await signer.remote.load(Comlink.transfer({ kind: "port", port: port2, size: Number(source.file.size) }, [port2]))
		}

		return await signer.remote.load({ kind: "file", file: source.file })
	} catch (error) {
		log.warn("preview", "pdf signer load failed", error)

		return { ok: false, reason: "readFailed" }
	}
}

function unlockSigner(signer: SignerWorker, password: string): Promise<PdfSignerUnlock> {
	return signer.remote.unlock(password).catch((error: unknown) => {
		log.warn("preview", "pdf signer unlock failed", error)

		return { ok: false, reason: "readFailed" } as const
	})
}

export async function openPdfSigner(source: PdfSignerFileSource): Promise<OpenPdfSignerResult> {
	const token = crypto.randomUUID()
	let active = startSigner(false)
	let legacyTried = false
	let terminated = false
	const terminate = (): void => {
		if (terminated) {
			return
		}

		terminated = true
		active.stop()

		if (source.kind === "drive") {
			void sdkApi.cancelPreviewDownload(token)
		}
	}

	// Read through a call: terminate() may run while an unlock awaits.
	const stopped = (): boolean => terminated
	const loaded = await loadSigner(active, source, token)

	if (!loaded.ok) {
		terminate()

		return loaded
	}

	const unlock = async (password: string): Promise<PdfSignerUnlock> => {
		const result = await unlockSigner(active, password)

		if (result.ok || result.reason !== "algorithm" || legacyTried || stopped()) {
			return result
		}

		// Either a legacy container or a key type no signer takes (then the legacy signer answers "algorithm" too).
		legacyTried = true

		const legacy = startSigner(true)
		const reloaded = await loadSigner(legacy, source, token)

		if (stopped() || !reloaded.ok) {
			legacy.stop()

			return { ok: false, reason: "readFailed" }
		}

		active.stop()
		active = legacy

		return unlockSigner(active, password)
	}

	return {
		ok: true,
		signer: {
			unlock,
			sign: digest => active.remote.sign(digest),
			terminate
		}
	}
}
