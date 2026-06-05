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

/**
 * Returns the path inside a UUID-named parent directory, relative to that
 * parent (with leading "/"). Anchors on the UUID instead of slicing by a
 * known prefix, which means the result is independent of any symlink
 * differences between the absolutePath's origin and a JS-constructed
 * reference. Examples that all yield "/file.jpg":
 *
 *   /var/mobile/.../UUID/file.jpg                    (iOS, symlinked form)
 *   /private/var/mobile/.../UUID/file.jpg            (iOS, canonical form — what the SDK returns)
 *   /data/data/com.app/.../UUID/file.jpg             (Android)
 *   /Users/.../CoreSimulator/.../UUID/file.jpg       (iOS simulator)
 *
 * The UUID is an RFC 4122 v4 identifier (36 chars, hex + hyphens), so the
 * `/${uuid}/` anchor is unique enough in any reasonable filesystem path tree
 * that we don't need lexical prefix comparison. Returns null when the
 * anchor is not present (e.g. the absolutePath is the parent itself, or an
 * unrelated path was passed by mistake).
 */
export function extractPathInsideUuidDirectory(absolutePath: string, dirUuid: string): string | null {
	const anchor = `/${dirUuid}/`
	const idx = absolutePath.lastIndexOf(anchor)

	if (idx < 0) {
		return null
	}

	return absolutePath.slice(idx + anchor.length - 1)
}

export function normalizeFilePathForBlobUtil(filePath: string): string {
	return `file://${normalizeFilePathForSdk(filePath)}`
}
