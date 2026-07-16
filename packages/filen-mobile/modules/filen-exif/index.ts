import { requireOptionalNativeModule } from "expo-modules-core"

// Native metadata transplant used after a re-encode (HEIC→JPG conversion, camera-upload
// compression). Copies the source image's metadata into the re-encoded JPEG WITHOUT
// touching pixels:
//   - iOS: CGImageDestinationCopyImageSource copies the compressed image stream verbatim
//     and swaps in the source's full CGImageMetadata (standard EXIF + XMP), no decode/re-encode.
//   - Android: ExifInterface writes the standard EXIF tag set + XMP into a temp copy of the
//     JPEG, then atomically moves it over the target — no decode/re-encode.
// Orientation is forced to 1 on both (the re-encoded pixels are already upright). Best-effort
// by design: it never throws for a bad/mismatched file — it resolves `false` and the caller
// keeps the plain re-encoded file, exactly the pre-feature behavior.

type FilenExifNativeModule = {
	transplantMetadata: (sourceUri: string, targetUri: string) => Promise<boolean>
}

// requireOPTIONALNativeModule (not requireNativeModule): if the native module is absent — a JS
// bundle running on a binary that wasn't prebuilt with it (stale dev client / CI) — this returns
// null instead of throwing at import time, which would otherwise crash app startup through the
// import chain. The stub below then degrades to "no metadata carried".
const native = requireOptionalNativeModule<FilenExifNativeModule>("FilenExif")

/**
 * Copy `sourceUri`'s metadata into the re-encoded JPEG at `targetUri`, in place, without
 * re-encoding pixels, neutralizing orientation. Resolves `true` when the transplant completed,
 * `false` when there was nothing to carry, the operation could not complete, or the native
 * module is unavailable. On `false` the target file is left untouched and valid. Never rejects
 * for an ordinary read/parse failure — the transplant is always best-effort.
 */
export async function transplantMetadata(sourceUri: string, targetUri: string): Promise<boolean> {
	if (!native) {
		return false
	}

	return native.transplantMetadata(sourceUri, targetUri)
}
