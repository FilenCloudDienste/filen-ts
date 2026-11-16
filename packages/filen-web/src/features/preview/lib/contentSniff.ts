import { SNIFF_VERDICTS, type FileVerdict, type SniffId } from "@filen/shared"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { AnyFile } from "@filen/sdk-rs"
import { originSize, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import { sdkApi } from "@/lib/sdk/client"
import { openByteReader } from "@/features/preview/lib/origin/byteReader"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { MAX_SNIFF_HEAD_BYTES, SNIFFERS } from "@/features/preview/lib/contentSniff.logic"
import { probeTransportStream } from "@/features/preview/lib/transportStreamProbe"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"

export interface ContentSniffOptions {
	// The preview cache's scope (previewCacheScope).
	readonly scope: string | null
	readonly signal: AbortSignal
}

type Probe = (file: AnyFile, access: PreviewAccessMode, signal: AbortSignal) => Promise<boolean | null>

// The probe behind each probe-mode read: whether the file is what the read looks for, null when it could not be read.
const PROBES: Readonly<Partial<Record<SniffId, Probe>>> = {
	transportStream: probeTransportStream
}

async function probed(id: SniffId, origin: ByteOrigin, signal: AbortSignal): Promise<FileVerdict> {
	const probe = PROBES[id]

	if (probe === undefined || (origin.kind !== "file" && origin.kind !== "linkedFile")) {
		throw new Error(`no ${id} probe for a ${origin.kind} origin`)
	}

	const found = await probe(origin.file, origin.kind === "file" ? "authed" : "anon", signal)

	if (found === null) {
		throw new Error(`the ${id} probe could not be read`)
	}

	const [yes, no] = SNIFF_VERDICTS[id]

	return found ? yes : no
}

// The first `length` bytes of an origin, through the byte layer. A file of at most one block is loaded whole into the
// preview cache, where the buffered viewer opening next finds it; a larger one has one block read.
async function readHead(origin: ByteOrigin, length: number, token: string, options: ContentSniffOptions): Promise<Uint8Array> {
	if (originSize(origin) <= BLOCK_BYTES) {
		const bytes = await loadOriginBytes(origin, token, { cap: BLOCK_BYTES, store: true, scope: options.scope, signal: options.signal })

		return bytes.subarray(0, length)
	}

	const reader = await openByteReader(origin, token, { blocks: 1 })

	try {
		return await reader.read(0, length, options.signal)
	} finally {
		reader.close()
	}
}

async function head(origin: ByteOrigin, length: number, token: string, options: ContentSniffOptions): Promise<Uint8Array> {
	const stop = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	options.signal.addEventListener("abort", stop, { once: true })

	try {
		return await readHead(origin, length, token, options)
	} finally {
		options.signal.removeEventListener("abort", stop)
	}
}

// Runs the content read `id` on `origin` and returns its verdict; rejects when the bytes could not be read. A head read
// downloads under `token`, cancelled when `signal` aborts. A viewer-mode read is its viewer's, never run here.
export async function runContentSniff(id: SniffId, origin: ByteOrigin, token: string, options: ContentSniffOptions): Promise<FileVerdict> {
	const sniffer = SNIFFERS[id]

	switch (sniffer.mode) {
		case "viewer":
			throw new Error(`${id} is read by its viewer`)
		case "probe":
			return await probed(id, origin, options.signal)
		case "head":
			return sniffer.decide(await head(origin, Math.min(sniffer.headBytes, MAX_SNIFF_HEAD_BYTES), token, options), originSize(origin))
	}
}
