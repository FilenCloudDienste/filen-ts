import { extensionOf, mimeForExtension } from "@filen/shared"
import { HEIC_EXTENSIONS } from "@/features/preview/lib/imageFormat"
import type { SaveTarget, SourceInfo, SourceMime } from "@/features/preview/imageEdit/types"

// Where an edit can be saved. In place only where we can re-encode the same format without losing what it is
// (JPEG, 8-bit truecolour PNG, WebP where the engine encodes it); everything else becomes a JPEG copy, or a PNG
// copy when transparency must survive.

const JPEG_COPY: SaveTarget = { kind: "copy", mime: "image/jpeg", extension: "jpg" }
const PNG_COPY: SaveTarget = { kind: "copy", mime: "image/png", extension: "png" }

function convertedCopy(info: SourceInfo): SaveTarget {
	// GIF is palette art (flat colours, hard edges) that JPEG smears.
	return info.hasAlpha || info.mime === "image/gif" ? PNG_COPY : JPEG_COPY
}

export function saveTargets(info: SourceInfo, canEncodeWebp: boolean): { primary: SaveTarget; copy: SaveTarget } {
	switch (info.mime) {
		case "image/jpeg": {
			return { primary: { kind: "inPlace", mime: "image/jpeg" }, copy: JPEG_COPY }
		}

		case "image/png": {
			return { primary: info.pngTruecolor8 ? { kind: "inPlace", mime: "image/png" } : PNG_COPY, copy: PNG_COPY }
		}

		case "image/webp": {
			const copy = convertedCopy(info)

			return { primary: canEncodeWebp ? { kind: "inPlace", mime: "image/webp" } : copy, copy }
		}

		default: {
			const copy = convertedCopy(info)

			return { primary: copy, copy }
		}
	}
}

// The format an in-place save writes, from the name alone (sync; the sniffed bytes decide the rest later): the type the
// name's extension is served as, when the editor writes that type.
export function inPlaceFormatByName(name: string): "image/jpeg" | "image/png" | "image/webp" | null {
	const mime = mimeForExtension(extensionOf(name))

	switch (mime) {
		case "image/jpeg":
		case "image/png":
		case "image/webp": {
			return mime
		}

		default: {
			return null
		}
	}
}

// The extensions that name each sniffed format: a file whose bytes say another is not edited (its save would write one
// format under a name that says another).
const EXTENSION_FAMILIES: Readonly<Record<SourceMime, readonly string[]>> = {
	"image/jpeg": ["jpg", "jpeg", "jfif", "jpe", "pjpeg", "pjp"],
	"image/png": ["png", "apng"],
	"image/webp": ["webp"],
	"image/gif": ["gif"],
	"image/bmp": ["bmp", "dib"],
	"image/x-icon": ["ico"],
	"image/avif": ["avif"],
	"image/heic": [...HEIC_EXTENSIONS],
	"image/x-qoi": ["qoi"],
	"image/jxl": ["jxl"],
	"image/tiff": ["tif", "tiff"],
	"image/vnd.adobe.photoshop": ["psd"]
}

export function matchesExtension(name: string, mime: SourceMime): boolean {
	return EXTENSION_FAMILIES[mime].includes(extensionOf(name))
}

// Whether the sniffed file can be edited at all: a still image whose bytes are the format its name claims (a
// renamed file would be saved back under a name that lies about it). The size is not part of it: a TIFF whose first
// IFD lies past the head sniffs as 0 × 0, and the engine that draws its page knows the real one.
export function isEditableSource(info: SourceInfo, name: string): boolean {
	return !info.animated && matchesExtension(name, info.mime)
}
