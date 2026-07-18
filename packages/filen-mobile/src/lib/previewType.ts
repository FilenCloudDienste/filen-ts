import * as FileSystem from "expo-file-system"
import { EXPO_IMAGE_SUPPORTED_EXTENSIONS, EXPO_AUDIO_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"
import mimeTypes from "mime-types"

export type PreviewType = "image" | "svg" | "video" | "unknown" | "pdf" | "text" | "code" | "audio" | "docx"

export function getPreviewType(name: string): PreviewType {
	const extname = FileSystem.Paths.extname(name.trim().toLowerCase())

	// SVG is a distinct render type but image-equivalent everywhere it's classified (gallery /
	// photos membership, icon selection, size caps, save-to-photos — gate those with
	// isImagePreviewType, not `=== "image"`). It only diverges at the render layer, where it
	// goes through react-native-svg (PreviewSvg) instead of expo-image: on Android expo-image
	// decodes SVG via the unmaintained androidsvg 1.4, whose pattern rendering can recurse into
	// an uncatchable native OOM abort (bad_alloc → SIGABRT). Split out before the image set
	// check below (.svg is still IN that set, for eligibility).
	if (extname === ".svg") {
		return "svg"
	}

	if (EXPO_IMAGE_SUPPORTED_EXTENSIONS.has(extname)) {
		return "image"
	}

	if (EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(extname)) {
		return "video"
	}

	if (EXPO_AUDIO_SUPPORTED_EXTENSIONS.has(extname)) {
		return "audio"
	}

	switch (extname) {
		case ".pdf": {
			return "pdf"
		}

		case ".txt": {
			return "text"
		}

		case ".js":
		case ".cjs":
		case ".mjs":
		case ".jsx":
		case ".tsx":
		case ".ts":
		case ".md":
		case ".cpp":
		case ".c":
		case ".php":
		case ".htm":
		case ".html5":
		case ".html":
		case ".css":
		case ".css3":
		case ".coffee":
		case ".litcoffee":
		case ".sass":
		case ".xml":
		case ".json":
		case ".sql":
		case ".java":
		case ".kt":
		case ".swift":
		case ".py3":
		case ".py":
		case ".cmake":
		case ".cs":
		case ".dart":
		case ".dockerfile":
		case ".go":
		case ".less":
		case ".yaml":
		case ".vue":
		case ".svelte":
		case ".vbs":
		case ".cobol":
		case ".toml":
		case ".conf":
		case ".ini":
		case ".log":
		case ".makefile":
		case ".mk":
		case ".gradle":
		case ".lua":
		case ".h":
		case ".hpp":
		case ".rs":
		case ".sh":
		case ".rb":
		case ".ps1":
		case ".bat":
		case ".ps":
		case ".protobuf":
		case ".proto": {
			return "code"
		}

		case ".docx": {
			return "docx"
		}

		default: {
			return "unknown"
		}
	}
}

export function getPreviewTypeFromMime(mimeType: string): PreviewType {
	const normalizedMimeType = mimeType.toLowerCase().trim()
	const extname = mimeTypes.extension(normalizedMimeType)

	if (!extname) {
		return "unknown"
	}

	return getPreviewType(`file.${extname}`)
}

// SVG previews render via react-native-svg but are image-equivalent for classification
// (gallery / photos membership, icon selection, save-to-photos, size caps). Use this instead
// of `previewType === "image"` at any eligibility site so SVGs keep behaving like images; the
// only places that keep the literal `"image"` are the actual render sinks (which route `"svg"`
// to PreviewSvg), and the chat inline-attachment gate (which deliberately drops `"svg"` OUT of
// the inline-image path — internal link → file chip, external link → plain link — rather than
// decoding an untrusted SVG inline via expo-image).
export function isImagePreviewType(previewType: PreviewType): previewType is "image" | "svg" {
	return previewType === "image" || previewType === "svg"
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

	let replacements = 0

	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 0xfffd) {
			replacements++
		}
	}

	return replacements / text.length > 0.1
}
