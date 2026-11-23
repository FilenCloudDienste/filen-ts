import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js"
import type { PdfDigest, PdfDigestFactory, PdfDigestName } from "../../core/pdfsign"

// Signature digests. Input of an announced length up to ONE_SHOT_BYTES is gathered into one buffer and hashed by the
// platform's WebCrypto in a single call (native: about ten times noble's SHA-2). WebCrypto has no incremental digest and
// copies its input, so a larger input would hold two more copies of the signed bytes at once: that, input of unknown
// length, and a realm without WebCrypto (a WebView outside a secure context) stream through noble's SHA-2 instead,
// holding one run at a time. Neither waits on a WebAssembly compile: WebKit's on Linux sometimes never settled one in
// the engine worker.
export const ONE_SHOT_BYTES = 16 * 1024 * 1024

export interface PdfDigestSubtle {
	digest(algorithm: PdfDigestName, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>
}

interface Hasher {
	update(bytes: Uint8Array): unknown
	digest(): Uint8Array
}

const HASHERS: Readonly<Record<PdfDigestName, () => Hasher>> = {
	"SHA-256": () => sha256.create(),
	"SHA-384": () => sha384.create(),
	"SHA-512": () => sha512.create()
}

type DigestState =
	| { readonly kind: "gather"; readonly subtle: PdfDigestSubtle; readonly buffer: Uint8Array<ArrayBuffer>; filled: number }
	| { readonly kind: "stream"; readonly hasher: Hasher }

function streamed(hasher: Hasher): DigestState {
	return { kind: "stream", hasher }
}

// `length` is the number of bytes the caller will hash, when it knows it.
export function pdfDigestFactory(subtle: PdfDigestSubtle | undefined): PdfDigestFactory {
	return (name, length) => {
		let state: DigestState =
			subtle !== undefined && length !== undefined && length <= ONE_SHOT_BYTES
				? { kind: "gather", subtle, buffer: new Uint8Array(length), filled: 0 }
				: streamed(HASHERS[name]())

		return Promise.resolve<PdfDigest>({
			update(bytes: Uint8Array): void {
				if (state.kind === "stream") {
					state.hasher.update(bytes)

					return
				}

				if (state.filled + bytes.length <= state.buffer.length) {
					// Copied: a caller's view (MuPDF's heap) may be detached by the time the digest is made.
					state.buffer.set(bytes, state.filled)
					state.filled += bytes.length

					return
				}

				// More than announced: streams from here on.
				const hasher = HASHERS[name]()

				hasher.update(state.buffer.subarray(0, state.filled))
				hasher.update(bytes)
				state = streamed(hasher)
			},
			async digest(): Promise<Uint8Array> {
				if (state.kind === "stream") return state.hasher.digest()

				const { buffer, filled } = state

				return new Uint8Array(await state.subtle.digest(name, filled === buffer.length ? buffer : buffer.subarray(0, filled)))
			}
		})
	}
}

function platformSubtle(): PdfDigestSubtle | undefined {
	const crypto: unknown = Reflect.get(globalThis, "crypto")
	const subtle: unknown = typeof crypto === "object" && crypto !== null ? Reflect.get(crypto, "subtle") : undefined

	return typeof subtle === "object" && subtle !== null && typeof Reflect.get(subtle, "digest") === "function"
		? (subtle as PdfDigestSubtle)
		: undefined
}

let platform: PdfDigestFactory | undefined

export const createPdfDigest: PdfDigestFactory = (name, length) => {
	platform ??= pdfDigestFactory(platformSubtle())

	return platform(name, length)
}
