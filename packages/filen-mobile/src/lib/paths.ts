import * as FileSystem from "expo-file-system"
import pathModule from "path"

export function normalizeFilePathForSdk(filePath: string): string {
	let normalizedPath = filePath
		.trim()
		.replace(/^file:\/+/, "/")
		.split("/")
		.map(segment => {
			if (segment.length === 0) {
				return segment
			}

			// decodeURIComponent throws URIError on malformed percent-escapes (e.g. a literal "%" in a
			// decrypted remote filename like "Invoice 50%.pdf"). Fall back to the raw segment so a single
			// bad escape never crashes the surrounding transfer/offline/drive operation.
			try {
				return decodeURIComponent(segment)
			} catch {
				return segment
			}
		})
		.join("/")

	if (!normalizedPath.startsWith("/")) {
		normalizedPath = "/" + normalizedPath
	}

	if (normalizedPath.endsWith("/") && normalizedPath !== "/") {
		normalizedPath = normalizedPath.slice(0, -1)
	}

	return pathModule.posix.normalize(normalizedPath)
}

export function normalizeFilePathForExpo(filePath: string): string {
	let normalizedPath = FileSystem.Paths.normalize(
		normalizeFilePathForSdk(filePath)
			.split("/")
			.map(segment => (segment.length > 0 ? encodeURIComponent(segment) : segment))
			.join("/")
	)

	if (!normalizedPath.startsWith("/")) {
		normalizedPath = "/" + normalizedPath
	}

	if (normalizedPath.endsWith("/") && normalizedPath !== "/") {
		normalizedPath = normalizedPath.slice(0, -1)
	}

	return `file://${normalizedPath}`
}

export function normalizeFilePathForBlobUtil(filePath: string): string {
	return `file://${normalizeFilePathForSdk(filePath)}`
}

/**
 * A URI reduced to its path, with any `?query` and `#fragment` dropped.
 *
 * A URI and a filesystem path give the same characters opposite meanings: in a path every byte is
 * literal, so a file really can be named `notes#2.txt`; in a URI `#` is punctuation that ends the
 * path. The normalize helpers above implement the PATH rule — they percent-encode `#` so a literal
 * one survives the round trip — which is correct for their contract and has to stay that way.
 *
 * So a URI has to be reduced to a path BEFORE reaching them, or its punctuation is promoted to
 * literal characters and the result names a file that cannot exist. `MediaLibrary.Asset.getUri()`
 * returns `AVURLAsset.url.absoluteString` on iOS, and for some videos AVFoundation appends a
 * fragment holding a base64 property list of playback hints (e.g. `RecommendedForImmersiveMode` on
 * an HDR/immersive variant). Encoding that `#` to `%23` made the native hasher resolve a path with
 * a literal `#` in it, so those assets ENOENT'd and failed on every sync pass, forever.
 *
 * Cutting at the first BARE `#` is unambiguous precisely because the input is a real URI: both
 * platforms build it with an encoder (Foundation on iOS, `File.toUri()` on Android), so a `#` that
 * belongs to a filename arrives as `%23` and only a delimiter survives raw. A plain path gets no
 * such guarantee, which is why the scheme guard below returns it untouched rather than truncating
 * a legitimately-named file.
 *
 * Removing the fragment here — before anything splits on `/` — also matters because a base64
 * payload can itself contain `/`, which would otherwise be read as extra path segments.
 */
export function stripUriFragmentAndQuery(uri: string): string {
	// No scheme means a plain path, where "#" and "?" are ordinary filename characters.
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) {
		return uri
	}

	const fragmentIndex = uri.indexOf("#")
	const withoutFragment = fragmentIndex === -1 ? uri : uri.slice(0, fragmentIndex)
	const queryIndex = withoutFragment.indexOf("?")

	return queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex)
}
