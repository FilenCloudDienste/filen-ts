import { createSHA256, createSHA384, createSHA512, type IHasher } from "hash-wasm"
import type { PdfDigest, PdfDigestName } from "../../core/pdfsign"

// Incremental SHA-2 for signature digests (WebCrypto hashes only whole buffers). hash-wasm keeps one small wasm
// instance per algorithm; each digest gets its own hasher state.

const FACTORIES: Readonly<Record<PdfDigestName, () => Promise<IHasher>>> = {
	"SHA-256": createSHA256,
	"SHA-384": createSHA384,
	"SHA-512": createSHA512
}

export async function createPdfDigest(name: PdfDigestName): Promise<PdfDigest> {
	const hasher = await FACTORIES[name]()

	hasher.init()

	return {
		update(bytes: Uint8Array): void {
			hasher.update(bytes)
		},
		digest(): Uint8Array {
			return hasher.digest("binary")
		}
	}
}
