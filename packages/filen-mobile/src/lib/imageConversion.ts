import * as FileSystem from "expo-file-system"
import * as ImageManipulator from "expo-image-manipulator"
import { randomUUID } from "expo-crypto"
import { newTmpFile } from "@/lib/tmp"
import { normalizeFilePathForExpo } from "@/lib/paths"
import { renderAndSave } from "@/lib/imageManipulator"
import { transplantMetadata } from "@/modules/filen-exif"
import secureStore from "@/lib/secureStore"
import logger from "@/lib/logger"

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

const HEIC_EXTENSIONS: ReadonlySet<string> = new Set(["heic", "heif", "heics", "heifs"])

// Whether a filename or file URI names a HEIC/HEIF image, by its trailing extension.
// Deliberately a PLAIN string check, NOT FileSystem.Paths.extname — the latter
// decodeURIComponent()s file:// URIs and throws URIError on a literal/malformed '%'
// in a picked filename (drive DocumentPicker/ImagePicker hand us raw file:// URIs).
// Any query/fragment is stripped first; .heics/.heifs are the multi-image burst variants.
export function isHeicFile(nameOrUri: string): boolean {
	const bareName = (nameOrUri.split(/[?#]/, 1)[0] ?? nameOrUri).toLowerCase()

	return HEIC_EXTENSIONS.has(bareName.slice(bareName.lastIndexOf(".") + 1))
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
		const result = await renderAndSave(normalizeFilePathForExpo(file.uri), {
			compress: HEIC_JPG_QUALITY,
			format: ImageManipulator.SaveFormat.JPEG
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

		// Carry the original HEIC's EXIF/XMP into the converted JPEG (native, no pixel
		// re-encode, orientation neutralized). Best-effort: `file` (the HEIC source) is still
		// intact, and on any failure `target` stays the plain converted file — exactly the
		// pre-feature behavior. Runs off the JS/UI thread and is safe from the background task
		// (atomic replace + fail-open, so a task-expiry suspension can't corrupt `target`).
		try {
			await transplantMetadata(file.uri, target.uri)
		} catch (e) {
			logger.warn("cameraUpload", "HEIC metadata transplant failed, keeping converted file without metadata", {
				uri: file.uri,
				error: e
			})
		}

		return target
	} catch (e) {
		logger.warn("cameraUpload", "HEIC to JPG conversion failed, uploading original", { uri: file.uri, error: e })

		return file
	}
}
