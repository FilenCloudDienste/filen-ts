import { vi } from "vitest"
import { File } from "@/tests/mocks/expoFileSystem"

/**
 * Shared mock of `react-native-blob-util` (default export shape).
 *
 * Any test that loads a real module importing it must mock it — the real package pulls in
 * `react-native`, which does not load in the node test env. Use:
 *
 *   vi.mock("react-native-blob-util", async () => await import("@/tests/mocks/reactNativeBlobUtil"))
 *
 * `fs.hash` deliberately delegates to the expo-file-system mock's in-memory fs rather than keeping a
 * table of its own, so a single seeded file is visible to BOTH the expo File API (which camera
 * upload still uses for `exists` and `copy`) and the hash, and so a test that overrides
 * `File.prototype.md5` still steers the hash. Production hands blob-util a decoded, scheme-less
 * path while that fs is keyed by the `file://` uri, so the prefix is put back before delegating —
 * mirroring what `normalizeFilePathForSdk` stripped.
 */
async function hash(path: string, algorithm: string): Promise<string> {
	if (algorithm !== "md5") {
		throw new Error(`EINVAL: unsupported algorithm '${algorithm}' in the test mock`)
	}

	// Modelled on the native behaviour, not made lenient: iOS hands this argument straight to
	// `fileExistsAtPath:`, which does not understand a URL, so a caller that forgot to strip the
	// scheme gets ENOENT on a device. Rejecting it here means that mistake fails a test instead of
	// only failing in the field.
	if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
		throw new Error(`ENOENT: no such file '${path}' (a scheme-qualified URI is not a filesystem path)`)
	}

	// The real filesystem holds one file however its URI is spelled, but the expo mock's fs is a Map
	// keyed by the literal uri a test seeded. Try the decoded spelling first, then the percent-encoded
	// one, so a test may seed either.
	const encoded = path.split("/").map(encodeURIComponent).join("/")
	const md5 = new File(`file://${path}`).md5 ?? new File(`file://${encoded}`).md5

	if (!md5) {
		throw new Error(`ENOENT: no such file '${path}'`)
	}

	return md5
}

export const mockBlobUtilHash = vi.fn(hash)

export default {
	fs: {
		hash: mockBlobUtilHash,
		dirs: {
			LegacyDownloadDir: "/storage/emulated/0/Download",
			DocumentDir: "/data/user/0/io.filen.app/files",
			CacheDir: "/data/user/0/io.filen.app/cache"
		},
		exists: vi.fn(async () => false),
		unlink: vi.fn(async () => undefined)
	},
	MediaCollection: {
		copyToMediaStore: vi.fn(async () => "content://media/external/downloads/1")
	},
	android: {
		actionViewIntent: vi.fn(async () => undefined)
	}
}
