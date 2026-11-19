import type { ByteSink } from "../../opc/index"

// The sealed write of a PresentationML package ([MS-OFFCRYPTO] §2.3.4.10–§2.3.4.15): the package cannot stream (the
// compound file needs the EncryptedPackage size up front), so the caller zips it into memory and the zip is sealed
// as Agile by the realm that holds the key, then written to the sink. Its callers: the in-place save of an encrypted
// deck (dom/presentation/save.ts, measured by pptxSealPerf and proved by pptxWriteSeal) and the conversions of a
// protected source to PresentationML (convert/presentation).

// What seals a zip: over the session's PackageSealer (dom/encryption), which refuses once its key was released and
// reads the sealed file back as a compound file decrypting to `zip` before it returns it, so that check is not
// repeated here. Structural, so the core never imports the realm that holds the key.
export type PptxSeal = (zip: Uint8Array) => Promise<Uint8Array>

const CHUNK = 1024 * 1024

// `zip` sealed, then written to `sink` a chunk at a time and the sink closed; the sealed file. `sealed` sees it before
// the first write (the save's progress total). A seal that rejects rejects this, nothing written and the sink open.
export async function sealInto(zip: Uint8Array, seal: PptxSeal, sink: ByteSink, sealed?: (file: Uint8Array) => void): Promise<Uint8Array> {
	const file = await seal(zip)

	sealed?.(file)

	for (let at = 0; at < file.length; at += CHUNK) await sink.write(file.subarray(at, Math.min(file.length, at + CHUNK)))
	await sink.close()

	return file
}
