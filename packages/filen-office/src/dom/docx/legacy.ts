import { DocError, type DocEncryptionScheme, type DocErrorCode } from "../../core/doc/index"
import { convertDocToDocx, docxPackage, withProtectionHash, type DocNotConverted } from "../../core/doc/toDocx/index"
import { nativeDeflate } from "../../core/docx/write/zip"
import { bytesSource, memorySink, OpcPackage, writeZip, type ByteSource } from "../../core/opc/index"
import { decodeUtf8, encodeUtf8 } from "../../core/xml/index"
import { OfficeCryptoError } from "../encryption/errors"
import { decryptionOf } from "../encryption/legacyDecryption"
import { subtle } from "../encryption/subtle"
import { hashLegacyProtectionKey } from "../protection"
import type { DocxHost } from "./host"
import type { DocxProtectionOptions } from "./protection"

export type { DocNotConverted, DocNotConvertedKind } from "../../core/doc/toDocx/index"

// Word 97–2003 binary documents (.doc, .dot) where the document engine runs (web: the docx worker): converted to a
// WordprocessingML package once, held there, and opened from it read-only. The binary source is not kept: once the
// conversion is done only the package is. Save as .docx takes a copy of the package.
//
// A file with a password to open (XOR, RC4 or CryptoAPI RC4, [MS-DOC] §2.2.6) is refused as "encrypted" until it is
// opened again with a password: "wrongPassword" when it does not match. The password goes with that one request and
// is not kept; the package it becomes is not encrypted, nor is any copy of it.

// Why a Word binary document is not converted (the reader's DocError code; `encryption` names the scheme of an
// encrypted file).
export interface DocxLegacyRefusal {
	readonly reason: DocErrorCode
	readonly encryption?: DocEncryptionScheme
	readonly nFib?: number
}

export type DocxLegacyOpen =
	| { readonly kind: "converted"; readonly document: DocxConvertedDocument }
	| { readonly kind: "refused"; readonly refusal: DocxLegacyRefusal }
	| { readonly kind: "aborted" }

export interface DocxConvertedDocument {
	// The viewer's source: { host, bytes }. The host opens the package where it is held; `bytes` gives its size only.
	readonly host: DocxHost
	readonly bytes: ByteSource
	// What the conversion could not carry over as it was, for the viewer to say.
	readonly notConverted: readonly DocNotConverted[]
	// The file had a password to open: the package and its copies are not encrypted.
	readonly decrypted: boolean
	// A copy of the package, for Save as .docx.
	take(options?: DocxProtectionOptions): Promise<Uint8Array>
	// Drops the package where it is held; call once every session on it closed.
	release(): void
}

export interface DocxLegacyOptions extends DocxProtectionOptions {
	// The password to open an encrypted file (after it was refused as "encrypted").
	readonly password?: string
}

// Converts files that may be Word binary documents (docxWorkerPool(...).legacy).
export interface DocxLegacy {
	open(source: ByteSource, options?: DocxLegacyOptions): Promise<DocxLegacyOpen>
}

export type DocxConvertAnswer =
	| { readonly ok: true; readonly size: number; readonly notConverted: readonly DocNotConverted[]; readonly decrypted: boolean }
	| { readonly ok: false; readonly refusal: DocxLegacyRefusal }

export interface DocxLegacyServer {
	convert(id: number, source: ByteSource, password?: string): Promise<DocxConvertAnswer>
	// The package of a converted document, for an engine session opened on it.
	package(id: number): Uint8Array | undefined
	// A copy of the package; a password on its editing restrictions is hashed into it here, as only the copy needs it.
	take(id: number, options?: DocxProtectionOptions): Promise<Uint8Array>
	// Drops a held document; false when `id` is not one.
	close(id: number): boolean
}

function refusalOf(error: DocError): DocxLegacyRefusal {
	return {
		reason: error.code,
		...(error.encryption === undefined ? {} : { encryption: error.encryption }),
		...(error.nFib === undefined ? {} : { nFib: error.nFib })
	}
}

// WebCrypto is there to hash a protection key with (it is not in a WebView outside a secure context).
function canHash(): boolean {
	try {
		subtle()

		return true
	} catch (error) {
		if (error instanceof OfficeCryptoError) return false

		throw error
	}
}

const SETTINGS_PART = "word/settings.xml"

// `bytes` (a converted package) with the hash of `key` in its settings part; every other entry is copied as it is.
async function withProtectionKey(bytes: Uint8Array, key: number, options: DocxProtectionOptions): Promise<Uint8Array> {
	const hash = await hashLegacyProtectionKey(key, options.signal === undefined ? {} : { signal: options.signal })
	const original = await OpcPackage.open(bytesSource(bytes))
	const settings = encodeUtf8(withProtectionHash(decodeUtf8(await original.read(SETTINGS_PART)), hash))
	const plan = await original.plan({ replace: [{ name: SETTINGS_PART, bytes: settings }], add: [], remove: [] })
	const sink = memorySink()
	const deflate = nativeDeflate()

	await writeZip(plan, original.zip, sink, deflate === undefined ? {} : { deflate })

	return sink.bytes()
}

interface HeldPackage {
	readonly bytes: Uint8Array
	// The key of a password on the editing restrictions, hashed into copies only (100,000 SHA-1s).
	readonly protectionKey: number | undefined
}

export function docxLegacyServer(): DocxLegacyServer {
	const held = new Map<number, HeldPackage | undefined>()

	return {
		async convert(id, source, password) {
			held.set(id, undefined)

			let bytes: Uint8Array
			let notConverted: readonly DocNotConverted[]
			let decrypted: boolean
			let protectionKey: number | undefined

			try {
				// A password on the editing restrictions goes over as the hash of its key (WebCrypto, where this runs),
				// spun when Save as takes a copy: the viewer never needs it.
				const result = await convertDocToDocx(source, {
					...(canHash() ? { protectionKey: "later" as const } : {}),
					...(password === undefined ? {} : { decryption: decryptionOf(password) })
				})
				const deflate = nativeDeflate()

				bytes = await docxPackage(result.parts, deflate === undefined ? {} : { deflate })
				notConverted = result.notConverted
				decrypted = result.encryption !== undefined
				protectionKey = result.protectionKey
			} catch (error) {
				held.delete(id)

				if (error instanceof DocError) return { ok: false, refusal: refusalOf(error) }

				throw error
			}

			// Closed while converting: nothing is kept.
			if (!held.has(id)) return { ok: false, refusal: { reason: "corrupt" } }

			held.set(id, { bytes, protectionKey })

			return { ok: true, size: bytes.length, notConverted, decrypted }
		},
		package(id) {
			return held.get(id)?.bytes
		},
		take(id, options = {}) {
			const document = held.get(id)

			if (document === undefined) return Promise.reject(new Error("The document is not converted"))

			if (document.protectionKey === undefined) return Promise.resolve(document.bytes.slice())

			return withProtectionKey(document.bytes, document.protectionKey, options)
		},
		close(id) {
			return held.delete(id)
		}
	}
}
