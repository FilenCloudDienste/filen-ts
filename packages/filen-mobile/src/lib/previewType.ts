import * as FileSystem from "expo-file-system"
// Metro aliases "path" to path-browserify (metro.config.js); under vitest it resolves to node's
// built-in. Both are ports of the same algorithm expo-file-system vendors, so extname is identical.
import pathModule from "path"
import { EXPO_IMAGE_SUPPORTED_EXTENSIONS, EXPO_AUDIO_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"
import { CODE_FILE_EXTENSIONS, effectiveExtension } from "@filen/shared"
import type { DriveItemFileExtracted } from "@/types"

export type PreviewType = "image" | "svg" | "rawImage" | "video" | "unknown" | "pdf" | "text" | "code" | "audio" | "docx"

/**
 * `FileSystem.Paths.extname` without the thrown exception.
 *
 * `Paths.extname` first calls `asUrl(name)`, which runs `new URL(name)` inside a try/catch — and on
 * React Native the global `URL` is Expo's pure-JS `whatwg-url-minimum`, not a native parser. A bare
 * filename has no scheme, so EVERY call constructs a TypeError, throws it through that parser, catches
 * it, and then falls through to the plain path parse it was always going to use. Measured ~36-68x the
 * cost of the parse itself, and this runs inside per-file loops (camera upload, file-cache paths). A
 * file's TYPE is read by fileTypeExtension instead.
 *
 * The colon guard is what keeps this an optimization rather than an assumption: WHATWG requires a
 * `:`-terminated scheme when there is no base, so a colon-free string provably cannot construct a URL
 * and `Paths.extname` provably reduces to the plain parse. Anything containing a colon keeps the
 * original path untouched — including its latent `URIError` on malformed percent-escapes
 * (`file:///a/b%zz.txt`), which is preserved deliberately rather than silently swallowed.
 */
export function extnameOf(name: string): string {
	return name.includes(":") ? FileSystem.Paths.extname(name) : pathModule.posix.extname(name)
}

// RAW camera containers whose embedded JPEG @filen/sdk-rs 0.4.42 can locate (writeEmbeddedPreviewToPath):
// the TIFF-layout families CR2, NEF, ARW, DNG, SRW, PEF, RW2, ORF (located by microthumb/src/formats/raw.rs,
// the IFD walker that formats/tiff.rs sniffs into), Fuji RAF (formats/raf.rs) and Canon CR3 (formats/cr3.rs)
// — unchanged since the filen-js@0.4.41 tag the filen-rs submodule sits on. Platform-independent — the
// preview is a JPEG; the platform never decodes the RAW. Classified "rawImage" below: previewable
// (extracted JPEG) and thumbnailable (SDK), never an expo-image or manipulator input, so it stays disjoint
// from both expo-image sets in constants.ts. Lives beside the classifier rather than in constants.ts so the
// many suites that mock @/constants with hand-picked exports need nothing new.
export const SDK_RAW_PREVIEW_EXTENSIONS = new Set<string>([".cr2", ".cr3", ".nef", ".arw", ".dng", ".srw", ".pef", ".rw2", ".orf", ".raf"])

// @filen/shared's CODE_FILE_EXTENSIONS plus the three extensions this app's single "code" preview
// category bundles in that web splits into its own markdown/text categories (see CODE_FILE_EXTENSIONS'
// own comment).
const MOBILE_CODE_EXTENSIONS = [...CODE_FILE_EXTENSIONS, "md", "markdown", "log"]

// Dot-less extension → preview type, one lookup per classification. First entry wins, which keeps the
// precedence the old chain of set checks had: .svg ahead of the image set that also holds it (it renders
// through react-native-svg, never expo-image — on Android expo-image decodes SVG via the unmaintained
// androidsvg 1.4, whose pattern rendering can recurse into an uncatchable native OOM abort; gate with
// isImagePreviewType, not `=== "image"`), image ahead of RAW (never an expo-image input: the gallery
// renders the JPEG the SDK extracts), video ahead of audio (.3gp is in both on Android), all media ahead of
// code (.ts is TypeScript, never a video).
const PREVIEW_TYPES: ReadonlyMap<string, PreviewType> = (() => {
	const types = new Map<string, PreviewType>([["svg", "svg"]])
	const add = (extensions: Iterable<string>, type: PreviewType) => {
		for (const extension of extensions) {
			const key = extension.startsWith(".") ? extension.slice(1) : extension

			if (!types.has(key)) {
				types.set(key, type)
			}
		}
	}

	add(EXPO_IMAGE_SUPPORTED_EXTENSIONS, "image")
	add(SDK_RAW_PREVIEW_EXTENSIONS, "rawImage")
	add(EXPO_VIDEO_SUPPORTED_EXTENSIONS, "video")
	add(EXPO_AUDIO_SUPPORTED_EXTENSIONS, "audio")
	add(MOBILE_CODE_EXTENSIONS, "code")
	add(["pdf"], "pdf")
	add(["txt"], "text")
	add(["docx"], "docx")

	return types
})()

function isPreviewableExtension(extension: string): boolean {
	return PREVIEW_TYPES.has(extension)
}

// The lowercase, dot-less extension a file's type is read from (@filen/shared's effectiveExtension): its
// own when this app can preview it, else a well-known name's (LICENSE, Makefile, .bashrc), else its stored
// mime's. Preview type, icon, editor language, thumbnails and the file-cache suffix all key on this, so
// they agree. Pure string work: a file name is not a URL, so this never reaches Paths.extname (extnameOf).
export function fileTypeExtension(name: string, mime?: string | null): string {
	return effectiveExtension(name, mime, isPreviewableExtension)
}

// `mime` is the file's stored metadata mime, where the caller has one; without it the name alone decides.
export function getPreviewType(name: string, mime?: string | null): PreviewType {
	return PREVIEW_TYPES.get(fileTypeExtension(name, mime)) ?? "unknown"
}

// An undecryptable file has neither name nor mime, and classifies "unknown".
export function getDriveItemPreviewType(item: DriveItemFileExtracted): PreviewType {
	return getPreviewType(item.data.decryptedMeta?.name ?? "", item.data.decryptedMeta?.mime)
}

// SVG previews render via react-native-svg and RAW camera files via the SDK-extracted JPEG, but
// both are image-equivalent for classification (gallery / photos membership, icon selection, size
// caps). Use this instead of `previewType === "image"` at any eligibility site; the places that
// keep the literal `"image"` are the render sinks (which route `"svg"` to PreviewSvg and
// `"rawImage"` to PreviewRawImage), the chat inline-attachment gate (which drops both OUT of the
// inline-image path rather than decoding untrusted or undisplayable bytes inline via expo-image)
// and save-to-photos (RAW excluded — product decision, see menuActionsDownload.ts).
export function isImagePreviewType(previewType: PreviewType): previewType is "image" | "svg" | "rawImage" {
	return previewType === "image" || previewType === "svg" || previewType === "rawImage"
}

// Whether lossily-decoded file content is more plausibly binary than text. Catches files
// that only wear a text extension — e.g. macOS "._*" AppleDouble sidecars (their magic
// starts with a NUL byte) — so the text preview can show a proper "not a text file" state
// instead of an invisible control-character soup or a wall of replacement characters.
export function isProbablyBinaryText(text: string): boolean {
	if (text.length === 0) {
		return false
	}

	if (text.includes("\u0000")) {
		return true
	}

	// indexOf rather than a per-character scan: U+FFFD is BMP and non-surrogate, so it counts exactly
	// what `charCodeAt(i) === 0xfffd` counted, and the engine's native search beats an interpreted loop
	// by ~80x on Hermes-bound text. Worth it because previewText feeds this uncapped multi-MB file
	// bodies on the JS thread.
	let replacements = 0
	let at = text.indexOf("\ufffd")

	while (at !== -1) {
		replacements++

		// Deliberately the SAME expression as the final return, not an algebraic rearrangement:
		// `replacements > text.length * 0.1` is not guaranteed bit-identical under IEEE-754. Division is
		// monotone in the numerator, so once this holds it holds for every later count.
		if (replacements / text.length > 0.1) {
			return true
		}

		at = text.indexOf("\ufffd", at + 1)
	}

	return replacements / text.length > 0.1
}
