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
