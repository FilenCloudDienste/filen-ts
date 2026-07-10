import { type DriveItem } from "@/features/drive/lib/item"
import { extensionOf } from "@/features/drive/lib/preview.logic"

// Every category this app can produce a cached thumbnail for; "none" covers every non-"file" arm
// (directory, every shared arm — out of scope here), an undecryptable file, an unrecognized
// extension, and a whole-buffer category over the size gate.
export type ThumbnailCategory = "image" | "heic" | "video" | "pdf" | "none"

// Square thumbnail bound (both dimensions) fed to every client-side generator — one shared target
// keeps every cached .thumb file roughly the same size.
export const THUMB_MAX_DIM = 256

// Whole-buffer decode/generate ceiling (64 MiB) for the categories that pull the ENTIRE file into
// memory to produce a thumbnail (image, heic, pdf) — an oversize file skips thumbnailing entirely
// rather than risking a tab-crashing allocation for a preview-sized image. video is exempt: its
// generator only ever reads a single frame off a stream, never the whole file.
export const THUMB_SIZE_GATE = 67_108_864n

// On-disk cache ceiling (256 MiB) — sweepThumbs evicts the oldest entries once the store exceeds
// this, so a long-lived session's thumbnail cache never grows unbounded.
export const THUMB_CACHE_CAP = 268_435_456

// Parent OPFS directory holding every thumbnail-cache generation, each as its own child directory —
// removeStaleThumbGenerations (thumbStore.ts) walks this root's children to evict everything that
// isn't THUMB_GENERATION, so a format change reclaims the old bytes instead of leaking them forever.
export const THUMB_DIR_ROOT = ["thumbnails"]

// Bumped whenever the cached bytes themselves change shape (a different max dimension, a different
// encode) — "v1" -> "v2" here for the 512 -> 256 THUMB_MAX_DIM drop above, so a stale 512px file can
// never serve under the new code; the store starts empty and the old generation gets swept.
export const THUMB_GENERATION = "v2"

// OPFS path segments under the origin's private root for the live generation's own cache tree.
export const THUMB_DIR = [...THUMB_DIR_ROOT, THUMB_GENERATION]

export const THUMB_EXT = ".thumb"

// Raster extensions the "image" category CANDIDATES for a client-side createImageBitmap decode. This
// is a candidacy list, NOT a support claim: whether the browser can actually decode a given format is
// proven per-file at decode time (createImageBitmap either yields a bitmap or throws), and a decode
// failure falls through to the service's own 3-strike blacklist rather than a hardcoded per-format
// gate here — so a format an older browser can't decode simply blacklists after three tries instead
// of pretending support up front. bmp and avif join the SDK-era set (jpg/jpeg/png/gif/webp) now that
// the browser, not the wasm decoder, owns decode; the item's own canMakeThumbnail flag no longer
// gates this arm for the same reason (it only ever described SDK-side decodability). svg stays
// EXCLUDED on purpose (sanitization posture — an untrusted svg is never fed to a decoder).
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"])
const HEIC_EXTENSIONS = new Set(["heic", "heif"])
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "m4v", "mkv"])

// Extension-first category routing, "file" arm only — a directory or any shared arm (shared items
// are out of scope here) always resolves "none", same as an undecryptable file (no name to route
// on). Every whole-buffer category (image, heic, pdf) additionally requires the file to be at or
// under THUMB_SIZE_GATE — video is exempt, its generator never buffers the whole file.
export function thumbnailCategory(item: DriveItem): ThumbnailCategory {
	if (item.type !== "file" || item.data.undecryptable) {
		return "none"
	}

	const name = item.data.decryptedMeta?.name
	const ext = name !== undefined ? extensionOf(name) : ""

	if (IMAGE_EXTENSIONS.has(ext)) {
		return item.data.size <= THUMB_SIZE_GATE ? "image" : "none"
	}

	if (HEIC_EXTENSIONS.has(ext)) {
		return item.data.size <= THUMB_SIZE_GATE ? "heic" : "none"
	}

	if (VIDEO_EXTENSIONS.has(ext)) {
		return "video"
	}

	if (ext === "pdf") {
		return item.data.size <= THUMB_SIZE_GATE ? "pdf" : "none"
	}

	return "none"
}

// name/size/lastModified projection of one cached .thumb file — thumbStore.ts's listThumbs() own
// return shape, and pickEvictions' own input below.
export interface ThumbCacheEntry {
	name: string
	size: number
	lastModified: number
}

// Oldest-first eviction until the running total is back at or under capBytes — pure so the boundary
// cases (already under cap, landing exactly on cap) are cheap to exhaust without touching OPFS.
export function pickEvictions(entries: ThumbCacheEntry[], capBytes: number): string[] {
	const total = entries.reduce((sum, entry) => sum + entry.size, 0)

	if (total <= capBytes) {
		return []
	}

	const oldestFirst = [...entries].sort((a, b) => a.lastModified - b.lastModified)
	const evict: string[] = []
	let remaining = total

	for (const entry of oldestFirst) {
		if (remaining <= capBytes) {
			break
		}

		evict.push(entry.name)
		remaining -= entry.size
	}

	return evict
}
