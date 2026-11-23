import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js"
import type { PdfDigest, PdfDigestName } from "../../core/pdfsign"

// Incremental SHA-2 for signature digests (WebCrypto hashes only whole buffers), in plain JS: made synchronously, so a
// check or a signing never waits on a WebAssembly compile. WebKit's on Linux sometimes never settled one in the engine
// worker (hash-wasm compiled its module there on each digest), and the check or signing then waited for good.

interface Hasher {
	update(bytes: Uint8Array): unknown
	digest(): Uint8Array
}

const HASHES: Readonly<Record<PdfDigestName, () => Hasher>> = {
	"SHA-256": () => sha256.create(),
	"SHA-384": () => sha384.create(),
	"SHA-512": () => sha512.create()
}

export function createPdfDigest(name: PdfDigestName): Promise<PdfDigest> {
	const hasher = HASHES[name]()

	return Promise.resolve({
		update(bytes: Uint8Array): void {
			hasher.update(bytes)
		},
		digest(): Uint8Array {
			return hasher.digest()
		}
	})
}
