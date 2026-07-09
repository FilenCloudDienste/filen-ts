import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { previewType, needsImageTransform } from "@/features/drive/lib/preview.logic"
import { isAllowedInlineContentType } from "@/lib/sw/protocol"

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
export function allowedMediaContentType(item: DriveItem): string | null {
	const category = previewType(item)

	if (category !== "video" && category !== "audio" && category !== "image") {
		return null
	}

	// HEIC/HEIF resolve to "image" but can never stream (no browser decodes them inline) — excluded
	// independently of the mime check below, so a spoofed streamable mime on a HEIC-named file can't
	// slip through (defense-in-depth: imageViewer.tsx's own dispatch checks this first too).
	if (needsImageTransform(item)) {
		return null
	}

	const base = asDirectoryOrFile(item)
	const mime = base.type === "file" ? base.data.decryptedMeta?.mime : undefined

	if (mime === undefined) {
		return null
	}

	const normalized = mime.toLowerCase().trim()

	return isAllowedInlineContentType(normalized) ? normalized : null
}
