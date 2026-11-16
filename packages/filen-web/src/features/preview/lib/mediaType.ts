import { driveItemMime, type DriveItem } from "@/features/drive/lib/item"
import { itemFileKind, needsImageTransform, isStreamedCategory } from "@/features/drive/lib/preview.logic"
import { isAllowedInlineContentType } from "@/lib/sw/protocol"
import { AUDIO_FORMATS, canonicalInlineType, mimeForExtension } from "@filen/shared"
import { deviceProfile, type DeviceProfile } from "@/lib/deviceProfile"

// The page-side half of the inline-preview allowlist gate (the SW's own independent re-check lives in
// sw.ts via the same isAllowedInlineContentType — see protocol.ts's own doc comment). First derives
// the category from the item's name/extension (previewType — extension-first, mime-fallback, already
// tested), which is trusted code-owned classification, not raw user input; only once that resolves to
// a streamable category does the item's OWN decrypted mime (attacker-controlled for a file someone
// else encrypted and shared in) get checked against the shared allowlist. Neither the category gate
// nor the mime check alone is sufficient — a whole-buffer category with a spoofed video/audio mime
// must still fall through here, and a genuinely video/audio/image file with an unrecognized or absent
// mime has nothing safe to serve as its inline Content-Type. `null` means "not inline-streamable" —
// every caller falls back to the buffered blob path or a plain download, never a hard error.
// The type the inline route serves a file of `extension` as, when the file's own type cannot be served: the
// extension's canonical type (mimeForExtension), code-owned, so the route serves what the extension promises and the
// browser plays it as it is instead of having it decoded. Null where the allowlist refuses it.
export function inlineTypeForExtension(extension: string): string | null {
	const mime = mimeForExtension(extension)

	return mime !== null && isAllowedInlineContentType(mime) ? mime : null
}

const GENERIC_TYPES: ReadonlySet<string> = new Set(["", "application/octet-stream", "binary/octet-stream"])

// Never served by a type the file did not store itself: SVG and its compressed form carry script, PostScript is a
// program; and the formats the remux worker decodes, which no browser plays as they are.
const NO_RESCUE: ReadonlySet<string> = new Set([
	"svg",
	"svgz",
	"eps",
	...[...AUDIO_FORMATS].filter(([, format]) => format.decoded === true).map(([extension]) => extension)
])

export function isRescuable(extension: string): boolean {
	return !NO_RESCUE.has(extension)
}

// `profile` decides the formats only some browsers decode (streamsNatively); a component passes its subscribed one.
export function allowedMediaContentType(item: DriveItem, profile: DeviceProfile = deviceProfile()): string | null {
	const kind = itemFileKind(item)
	const category = kind?.kind ?? "other"

	// "rawImage" is not a streamed category: a RAW container has no browser decoder, so serving one
	// inline would hand the page bytes nothing can render, and a camera's RAW mime (image/x-nikon-nef
	// and friends) must never be treated as a streamable image just because it starts with "image/".
	if (kind === null || !isStreamedCategory(category)) {
		return null
	}

	// An image this browser does not decode by itself (HEIC/HEIF without a native decoder) never streams, whatever
	// type it stored: excluded ahead of the type checks below (imageViewer.tsx routes on the same rule).
	if (needsImageTransform(item, profile)) {
		return null
	}

	const normalized = driveItemMime(item)?.toLowerCase().trim()

	// 1. The stored type, as it is.
	if (normalized !== undefined && isAllowedInlineContentType(normalized)) {
		return normalized
	}

	if (!isRescuable(kind.extension)) {
		return null
	}

	// 2. The stored type's canonical form (`image/pjpeg` → `image/jpeg`).
	const canonical = normalized === undefined ? null : canonicalInlineType(normalized)

	if (canonical !== null && isAllowedInlineContentType(canonical)) {
		return canonical
	}

	// 3. No type or a generic binary one: the type of the extension the kind was resolved for, however it was settled
	// (an ambiguous `.m4a` or `.ogg` by its usual meaning or a content verdict, which a generic type never
	// contradicts). A specific type that is not allowlisted is still refused.
	return normalized === undefined || GENERIC_TYPES.has(normalized) ? inlineTypeForExtension(kind.extension) : null
}
