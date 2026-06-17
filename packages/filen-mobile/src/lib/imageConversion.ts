import * as FileSystem from "expo-file-system"
import * as ImageManipulator from "expo-image-manipulator"
import { randomUUID } from "expo-crypto"
import { newTmpFile } from "@/lib/tmp"
import { normalizeFilePathForExpo } from "@/lib/paths"
import secureStore from "@/lib/secureStore"
import logger from "@/lib/logger"

// HEIC/HEIF file extensions (Apple's High Efficiency Image formats + their
// multi-image burst variants). Lowercased; matched against the trailing extension.
const HEIC_EXTENSIONS = new Set([".heic", ".heif", ".heics", ".heifs"])

// JPEG quality for the HEIC→JPG conversion. MAXIMUM (1.0) on purpose: this option
// exists for cross-device COMPATIBILITY, not size, so it must not throw away quality
// for its own sake — the separate "compress" option owns size reduction, and the two
// compose (convert at max quality first, then compress if that option is also on).
// JPEG is still lossy (even at 1.0 the re-encode applies DCT quantization, so it is
// near-lossless, not bit-exact), but dimensions are preserved (no resize).
const HEIC_JPG_QUALITY = 1

// Global secureStore key + default for the "Convert HEIC/HEIF to JPG" option. One
// setting, surfaced in both More → Advanced and the Camera Upload settings screen
// (both read/write this key), and read non-reactively by camera upload + drive uploads.
export const CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY = "convertHeicToJpgEnabled"
export const DEFAULT_CONVERT_HEIC_TO_JPG_ENABLED = false

// Whether a filename or file URI names a HEIC/HEIF image, by its trailing extension.
// Deliberately a PLAIN string check, NOT FileSystem.Paths.extname — the latter
// decodeURIComponent()s file:// URIs and throws URIError on a literal/malformed '%'
// in a picked filename (drive DocumentPicker/ImagePicker hand us raw file:// URIs).
// Strip any query/fragment, then take the last path segment's trailing dot-suffix.
export function isHeicFile(nameOrUri: string): boolean {
	const path = nameOrUri.split(/[?#]/, 1)[0] ?? nameOrUri
	const lastSegment = path.slice(path.lastIndexOf("/") + 1)
	const dotIndex = lastSegment.lastIndexOf(".")

	if (dotIndex <= 0) {
		return false
	}

	return HEIC_EXTENSIONS.has(lastSegment.slice(dotIndex).toLowerCase())
}

// Non-reactive read of the global toggle for lib/sync contexts (no React hook).
export async function isConvertHeicToJpgEnabled(): Promise<boolean> {
	return (await secureStore.get<boolean>(CONVERT_HEIC_TO_JPG_ENABLED_SECURE_STORE_KEY)) === true
}

// Convert a HEIC/HEIF file to JPG, returning a NEW `.jpg` file in filen-tmp. Non-HEIC
// input is returned unchanged. On ANY conversion failure the ORIGINAL file is returned
// so the upload still succeeds (as HEIC) — and because the camera-upload dedup key is
// extension-agnostic whenever this option is on, an un-converted fallback never loops.
export async function convertHeicToJpg(file: FileSystem.File): Promise<FileSystem.File> {
	if (!isHeicFile(file.uri)) {
		return file
	}

	try {
		// Hold the Context in a local binding across the await. expo-image-manipulator's
		// Context cancels its underlying coroutine task in sharedObjectDidRelease, so a
		// chained intermediate ref eligible for Hermes GC during renderAsync rejects with
		// JobCancellationException. (Same guard as cameraUpload.compress().)
		const context = ImageManipulator.ImageManipulator.manipulate(normalizeFilePathForExpo(file.uri))
		const rendered = await context.renderAsync()
		const result = await rendered.saveAsync({
			compress: HEIC_JPG_QUALITY,
			format: ImageManipulator.SaveFormat.JPEG,
			base64: false
		})

		const converted = new FileSystem.File(result.uri)

		if (!converted.exists) {
			return file
		}

		// Land the result in filen-tmp under a `.jpg` name so it survives the
		// sandbox-cache-clear action and the downstream upload-name logic sees `.jpg`.
		const target = newTmpFile(`${randomUUID()}.jpg`)

		if (target.exists) {
			target.delete()
		}

		await converted.move(target)

		return target
	} catch (e) {
		logger.warn("cameraUpload", "HEIC to JPG conversion failed, uploading original", { uri: file.uri, error: e instanceof Error ? e.message : String(e) })

		return file
	}
}
