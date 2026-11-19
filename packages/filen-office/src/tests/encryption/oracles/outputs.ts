import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

// The directory an external oracle (msoffcrypto-tool, Apache POI, LibreOffice UNO) is pointed at to check our
// encrypted output (docxEncryptedCorpus.test.ts writes one after sealing): each entry is a sealed OOXML file (a CFB holding
// EncryptionInfo + EncryptedPackage), its open password, and optionally the plaintext zip it must decrypt back
// to. The oracles never see a filen password at runtime — only these published test values.

export interface SealedEntry {
	// The sealed OOXML file, relative to the directory (or absolute).
	readonly file: string
	// The password that opens it.
	readonly password: string
	// The expected plaintext zip, relative to the directory (or absolute), when a byte-exact check is wanted.
	readonly plaintext?: string
}

export interface SealedOutputs {
	readonly dir: string
	readonly entries: readonly ResolvedEntry[]
}

export interface ResolvedEntry {
	readonly name: string
	readonly file: string
	readonly password: string
	readonly plaintext?: string
}

interface SealedManifest {
	readonly version: 1
	readonly entries: readonly SealedEntry[]
}

// The sealed-output directory an oracle run is pointed at: FILEN_OFFICE_SEALED when set (it must exist).
export function sealedOutputsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const dir = env["FILEN_OFFICE_SEALED"]

	if (dir === undefined || dir === "") return undefined
	if (!existsSync(dir)) throw new Error(`FILEN_OFFICE_SEALED does not exist: ${dir}`)

	return resolve(dir)
}

// Reads <dir>/manifest.json ({ version: 1, entries: [...] }) and resolves every path against the directory.
export function readSealedOutputs(dir: string): SealedOutputs {
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as SealedManifest

	if (manifest.version !== 1) throw new Error(`unknown sealed-output manifest version: ${JSON.stringify(manifest.version)}`)

	const under = (path: string): string => (isAbsolute(path) ? path : join(dir, path))

	return {
		dir,
		entries: manifest.entries.map(entry => ({
			name: entry.file,
			file: under(entry.file),
			password: entry.password,
			...(entry.plaintext !== undefined && { plaintext: under(entry.plaintext) })
		}))
	}
}

// What every oracle reports for one sealed entry.
export interface OracleResult {
	readonly ok: boolean
	// The decrypted plaintext size, when the oracle got that far.
	readonly plaintextSize?: number
	// Whether the plaintext begins with the zip signature (a readable OPC package).
	readonly startsPK?: boolean
	// Whether a data-integrity HMAC was present and verified (Agile only).
	readonly hmacVerified?: boolean
	// msoffcrypto-tool only: whether this tool version can check the data-integrity HMAC at all, and whether it did.
	readonly integritySupported?: boolean
	readonly integrityVerified?: boolean
	// Whether the plaintext equalled the entry's expected plaintext, when one was given.
	readonly matchedPlaintext?: boolean
	// Why the oracle rejected the file (wrong password, integrity, unsupported, or a tool error).
	readonly error?: string
}
