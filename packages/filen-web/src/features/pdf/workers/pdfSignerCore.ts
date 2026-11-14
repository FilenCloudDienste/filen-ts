import * as Comlink from "comlink"
import {
	buildPdfCms,
	certificateInfo,
	cmsCapacity,
	importPkcs12,
	PdfPkcs12Error,
	type PdfCertificateInfo,
	type PdfDigestName,
	type PdfLegacyCiphers,
	type PdfPkcs12Failure,
	type PdfSigningIdentity,
	type PdfSigningSubtle
} from "@filen/office/core/pdfsign"
import { rangePortReader } from "@/lib/media/rangePort"

// The certificate signer's work, behind the signer worker (pdfSigner.worker.ts): it reads a PKCS#12 container (from a
// drive file's range port, or a picked device file), unlocks it with the password, and signs digests with the key.
// The key never leaves this realm: it is a non-extractable CryptoKey, never posted, never stored, and the worker is
// terminated after signing or cancelling, which is what wipes it. The container's bytes are zeroed once unlocked.
// Containers older exports write (3DES or RC2) need node-forge's ciphers: only the legacy signer worker
// (pdfSignerLegacy.worker.ts) carries them, and the page starts it only for such a container.

// Certificate files are a few kilobytes; anything far larger is not one.
export const PDF_SIGNER_MAX_BYTES = 1024 * 1024

export type PdfSignerSource =
	// A drive file's ranges (sdk.worker's openRangePort), read once.
	| { readonly kind: "port"; readonly port: MessagePort; readonly size: number }
	// A file the user picked on the device: read here, never on the page.
	| { readonly kind: "file"; readonly file: Blob }

export type PdfSignerLoadFailure = "readFailed" | "tooLarge"

export interface PdfSignerSummary {
	readonly signer: PdfCertificateInfo
	// The signer first, then its issuers found in the container.
	readonly chain: readonly PdfCertificateInfo[]
	readonly digest: PdfDigestName
	// "RSA 2048", "ECDSA P-256", "Ed25519": as the verifier names them.
	readonly algorithm: string
	// Bytes the signature's CMS may take: what the placeholder is sized for.
	readonly capacity: number
}

export type PdfSignerUnlock =
	| { readonly ok: true; readonly summary: PdfSignerSummary }
	| { readonly ok: false; readonly reason: PdfPkcs12Failure | "notLoaded" | "readFailed" }

export interface PdfSignerApi {
	load(source: PdfSignerSource): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: PdfSignerLoadFailure }>
	unlock(password: string): Promise<PdfSignerUnlock>
	// The CMS over `digest` (the signed ranges' digest with summary.digest).
	sign(digest: Uint8Array): Promise<Uint8Array>
}

function algorithmLabel(identity: PdfSigningIdentity): string {
	const { scheme } = identity

	switch (scheme.name) {
		case "RSASSA-PKCS1-v1_5":
			return `RSA ${String(scheme.bits)}`
		case "RSA-PSS":
			return `RSA-PSS ${String(scheme.bits)}`
		case "ECDSA":
			return `ECDSA ${scheme.curve}`
		case "Ed25519":
			return "Ed25519"
	}
}

async function readSource(source: PdfSignerSource): Promise<Uint8Array | PdfSignerLoadFailure> {
	if (source.kind === "file") {
		if (source.file.size > PDF_SIGNER_MAX_BYTES) return "tooLarge"

		try {
			return new Uint8Array(await source.file.arrayBuffer())
		} catch {
			return "readFailed"
		}
	}

	const reader = rangePortReader(source.port)

	if (source.size > PDF_SIGNER_MAX_BYTES) {
		reader.close()

		return "tooLarge"
	}

	try {
		return await reader.readRange(0, source.size, new AbortController().signal)
	} catch {
		return "readFailed"
	} finally {
		reader.close()
	}
}

// `legacy`: node-forge's ciphers, for containers that need them; null answers such a container "algorithm".
export function createPdfSignerApi(subtle: PdfSigningSubtle, legacy: PdfLegacyCiphers | null): PdfSignerApi {
	let container: Uint8Array | null = null
	let identity: PdfSigningIdentity | null = null

	return {
		async load(source) {
			const read = await readSource(source)

			if (typeof read === "string") return { ok: false, reason: read }

			container?.fill(0)
			container = read
			identity = null

			return { ok: true }
		},
		async unlock(password) {
			if (container === null) return { ok: false, reason: "notLoaded" }

			try {
				identity = await importPkcs12(container, password, { subtle, legacy })
			} catch (error) {
				if (error instanceof PdfPkcs12Error) return { ok: false, reason: error.reason }

				throw error
			}

			container.fill(0)
			container = null

			return {
				ok: true,
				summary: {
					signer: certificateInfo(identity.chain[0] ?? missing()),
					chain: identity.chain.map(certificateInfo),
					digest: identity.scheme.digest,
					algorithm: algorithmLabel(identity),
					capacity: cmsCapacity(identity)
				}
			}
		},
		async sign(digest) {
			if (identity === null) throw new Error("signer is locked")

			return buildPdfCms(identity, digest, subtle)
		}
	}
}

function missing(): never {
	throw new Error("no signer certificate")
}

// A signer worker's entry: the core over Comlink, the CMS handed back transferred.
export function servePdfSigner(subtle: PdfSigningSubtle, legacy: PdfLegacyCiphers | null): void {
	const core = createPdfSignerApi(subtle, legacy)
	const api: PdfSignerApi = {
		load: source => core.load(source),
		unlock: password => core.unlock(password),
		sign: async digest => {
			const cms = await core.sign(digest)

			return Comlink.transfer(cms, [cms.buffer])
		}
	}

	Comlink.expose(api)
}
