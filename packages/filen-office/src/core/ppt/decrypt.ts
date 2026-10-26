import { cryptoApiBlockKey, type DocBlockKey, type DocDecryption } from "../doc/decrypt"
import { DocError } from "../doc/errors"
import { PresentationError } from "../presentation/model"
import { tooLarge } from "../presentation/refusal"
import { isEncryptedEdit, type PersistDirectory } from "./persist"
import { malformed, recordAt, RT, u16, u32 } from "./records"

// Password to open on a PowerPoint 97–2003 file ([MS-PPT] §2.3.7 CryptSession10Container; [MS-OFFCRYPTO] §2.3.5 RC4
// CryptoAPI, the only method the format has). The key comes from the CryptSession10Container's EncryptionHeader,
// whose header is in the clear; each persist object is one RC4 key stream from the key of its persist id, over 8 +
// the recLen its decrypted header gives; each field of a picture in the Pictures stream is a key stream of block 0.
// The UserEditAtom and PersistDirectoryAtom are in the clear. Decryption writes new arrays, never the source's.

export type PptDecryption = DocDecryption

export interface PptKey {
	readonly key: DocBlockKey
	// The persist id of the CryptSession10Container (left as it is).
	readonly session: number
}

// A DocError of the shared key derivation as the presentation refusal it is.
export function refusalOf(error: unknown): never {
	if (error instanceof DocError) {
		switch (error.code) {
			case "wrongPassword":
				throw new PresentationError("wrongPassword", error.message)
			case "encrypted":
				throw new PresentationError("unsupportedEncryption", error.message)
			default:
				throw new PresentationError("damagedEncryption", error.message)
		}
	}

	throw error
}

// The EncryptionHeader of the file's CryptSession10Container, read without the password; damaged when missing.
export function sessionHeader(stream: Uint8Array, directory: PersistDirectory): { readonly header: Uint8Array; readonly session: number } {
	if (!isEncryptedEdit(directory)) throw new PresentationError("damagedEncryption", "no CryptSession10Container")

	const session = directory.current.encryptSessionPersistIdRef
	const offset = directory.offsets.get(session) ?? -1

	if (offset < 0 || offset + 8 > stream.length) throw new PresentationError("damagedEncryption", "the CryptSession10Container is missing")

	let record

	try {
		record = recordAt(stream, offset)
	} catch {
		throw new PresentationError("damagedEncryption", "the CryptSession10Container is truncated")
	}

	if (record.type !== RT.cryptSession10Container) throw new PresentationError("damagedEncryption", "no CryptSession10Container")

	const header = stream.subarray(record.start, record.end)
	const major = u16(header, 0)
	const minor = u16(header, 2)

	// §2.3.7: RC4 CryptoAPI only (EncryptionVersionInfo 2.2, 3.2 or 4.2).
	if (header.length < 4 || major < 2 || major > 4 || minor !== 2) {
		throw new PresentationError("unsupportedEncryption", `EncryptionVersionInfo ${String(major)}.${String(minor)}`)
	}

	return { header, session }
}

// The key of `password`, checked against the verifier: wrongPassword, damagedEncryption or unsupportedEncryption.
export async function pptKey(stream: Uint8Array, directory: PersistDirectory, decryption: PptDecryption): Promise<PptKey> {
	const { header, session } = sessionHeader(stream, directory)

	try {
		return { key: await cryptoApiBlockKey(header, decryption), session }
	} catch (error) {
		return refusalOf(error)
	}
}

// The persist objects of `directory` decrypted: a copy of `stream` with each object's 8 + recLen bytes replaced.
export async function decryptPersistObjects(stream: Uint8Array, directory: PersistDirectory, key: PptKey): Promise<Uint8Array> {
	try {
		return await decryptObjects(stream, directory, key)
	} catch (error) {
		return refusalOf(error)
	}
}

// Persist objects do not overlap in a file PowerPoint wrote, so their key streams cover the stream at most once;
// objects claiming overlapping ranges would make the work ids × stream length, refused past twice the stream.
async function decryptObjects(stream: Uint8Array, directory: PersistDirectory, key: PptKey): Promise<Uint8Array> {
	const out = stream.slice()
	const budget = 2 * stream.length
	let work = 0

	for (const [id, offset] of directory.offsets) {
		if (id === key.session) continue
		if (offset + 8 > stream.length) continue

		const head = await key.key.decryptBlock(stream.subarray(offset, offset + 8), id)
		const end = offset + 8 + u32(head, 4)

		head.fill(0)

		// A persist object running past the stream is damage the reader refuses when it reads it.
		if (end > stream.length) continue

		work += end - offset

		if (work > budget) tooLarge("ppt decrypted bytes", budget)

		const plain = await key.key.decryptBlock(stream.subarray(offset, end), id)

		out.set(plain, offset)
		plain.fill(0)
	}

	return out
}

// [MS-ODRAW] §2.2.23–§2.2.31: the fields of a BLIP after rh, as the Pictures stream encrypts them one by one.
const TWO_UID_INSTANCES = new Set([0x3d5, 0x217, 0x543, 0x46b, 0x6e3, 0x6e1, 0x7a9, 0x6e5])
const METAFILE_TYPES = new Set([0xf01a, 0xf01b, 0xf01c])
const METAFILE_HEADER = 34

// One BLIP of an encrypted Pictures stream, decrypted into a new array (its record header at 0): rh, each UID, the
// metafile header or tag, then the picture data, each field a key stream of block 0. With `headOnly`, only rh and the
// fields before the picture data (what blipSize reads); the array's record still claims the whole length.
export async function decryptPicture(
	read: (offset: number, length: number) => Promise<Uint8Array>,
	offset: number,
	size: number,
	key: DocBlockKey,
	headOnly = false
): Promise<Uint8Array> {
	const head = await key.decryptBlock(await read(offset, 8), 0)
	const type = u16(head, 2)
	const instance = u16(head, 0) >> 4
	const length = u32(head, 4)

	if (length > size) malformed("a picture runs past its BLIP store entry")

	const fields: number[] = [16]

	if (TWO_UID_INSTANCES.has(instance)) fields.push(16)

	fields.push(METAFILE_TYPES.has(type) ? METAFILE_HEADER : 1)

	const taken = headOnly
		? Math.min(
				length,
				fields.reduce((sum, field) => sum + field, 0)
			)
		: length
	const body = await read(offset + 8, taken)
	const out = new Uint8Array(8 + taken)

	out.set(head)

	let at = 0

	for (const field of fields) {
		const take = Math.min(field, taken - at)

		if (take <= 0) break

		out.set(await key.decryptBlock(body.subarray(at, at + take), 0), 8 + at)
		at += take
	}

	if (at < taken) out.set(await key.decryptBlock(body.subarray(at), 0), 8 + at)

	return out
}
