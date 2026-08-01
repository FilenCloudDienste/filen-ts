import { vi } from "vitest"
import { File } from "@/tests/mocks/expoFileSystem"

/**
 * Shared mock of `@preeternal/react-native-file-hash`.
 *
 * Any test that loads a real module importing it must mock it — the real package is a TurboModule
 * and does not load in the node test env. Use:
 *
 *   vi.mock("@preeternal/react-native-file-hash", async () => await import("@/tests/mocks/reactNativeFileHash"))
 *
 * Like the blob-util mock it replaces, this delegates to the expo-file-system mock's in-memory fs
 * rather than keeping a table of its own, so one seeded file is visible to BOTH the expo File API
 * (which camera upload still uses for `exists` and `copy`) and the hash, and a test that overrides
 * `File.prototype.md5` steers the hash with it. Path resolution mirrors the natives — see
 * {@link nativePath}.
 */

/**
 * A stand-in BLAKE3 digest for content identified by `seed`.
 *
 * Deterministic and shaped like the real thing — 64 lowercase hex characters — so it survives the
 * same hex comparison production performs against a metadata hash. Tests pair it with
 * {@link blake3BytesForContent} to seed a remote file whose hash MATCHES a local one.
 */
export function blake3HexForContent(seed: string): string {
	let hex = ""

	// Four rounds of a cheap string hash, each contributing 16 hex characters. Not a real BLAKE3 and
	// not meant to be: nothing here verifies the algorithm, only that identical content produces one
	// digest and different content produces another.
	for (let round = 0; round < 4; round++) {
		let value = 0x811c9dc5 ^ round

		for (let index = 0; index < seed.length; index++) {
			value = Math.imul(value ^ seed.charCodeAt(index), 0x01000193) >>> 0
		}

		hex += value.toString(16).padStart(8, "0").repeat(2)
	}

	return hex
}

/** The same digest as raw bytes, which is how the SDK hands a metadata hash to JS. */
export function blake3BytesForContent(seed: string): ArrayBuffer {
	const hex = blake3HexForContent(seed)
	const bytes = new Uint8Array(32)

	for (let index = 0; index < 32; index++) {
		bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
	}

	return bytes.buffer
}

function decodeSegments(path: string): string {
	return path
		.split("/")
		.map(segment => {
			try {
				return decodeURIComponent(segment)
			} catch {
				return segment
			}
		})
		.join("/")
}

/**
 * What the natives resolve the argument to — modelled, not made lenient.
 *
 * A `file://` URI goes through `URL(string:).path` on iOS and `Uri.getPath()` on Android, both of
 * which decode EXACTLY ONCE. A bare path takes the fallback branch, where iOS applies
 * `removingPercentEncoding` — a second decode on top of any the caller already did. Production
 * therefore always passes an encoded `file://` URI; reproducing the trap here means a regression back
 * to a bare path fails a test instead of only failing on a device, and only for filenames containing
 * a literal `%XX`.
 */
function nativePath(filePath: string): string {
	if (/^file:\/\//i.test(filePath)) {
		return decodeSegments(filePath.replace(/^file:\/+/, "/"))
	}

	return decodeSegments(filePath)
}

async function hash(path: string, request?: { algorithm?: string; signal?: AbortSignal }): Promise<string> {
	const algorithm = request?.algorithm ?? "SHA-256"

	if (algorithm !== "MD5" && algorithm !== "BLAKE3") {
		throw new Error(`E_UNSUPPORTED_ALGORITHM: '${algorithm}' is not stubbed in the test mock`)
	}

	if (request?.signal?.aborted === true) {
		const error = new Error("E_CANCELLED") as Error & { code: string }

		error.code = "E_CANCELLED"

		throw error
	}

	const resolved = nativePath(path)

	// The real filesystem holds one file however its URI is spelled, but the expo mock's fs is a Map
	// keyed by the literal uri a test seeded. Try the decoded spelling first, then the percent-encoded
	// one, so a test may seed either.
	const encoded = resolved.split("/").map(encodeURIComponent).join("/")
	const md5 = new File(`file://${resolved}`).md5 ?? new File(`file://${encoded}`).md5

	if (!md5) {
		throw new Error(`E_FILE_NOT_FOUND: no such file '${path}'`)
	}

	// Both algorithms key off the SAME underlying content marker, so a test that gives two files
	// distinct md5s gets distinct BLAKE3 digests for free, and one that leaves them identical gets
	// matching digests — which is exactly the pairing the dedup logic keys on.
	return algorithm === "MD5" ? md5 : blake3HexForContent(md5)
}

/**
 * The default implementation, exported so a suite can restore it.
 *
 * `vi.clearAllMocks()` resets calls but NOT implementations, so a test that overrides this with
 * `mockImplementation` silently governs every test after it.
 */
export const fileHashImplementation = hash

export const mockFileHash = vi.fn(hash)

export const fileHash = mockFileHash
