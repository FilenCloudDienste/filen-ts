import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"

// Every category this app can produce a cached thumbnail for. "sdk" is every STILL raster image —
// plain raster, HEIC and camera RAW alike — decoded by the Rust SDK, which is the only decoder any of
// them ever sees now. "video", "pdf" and "svg" stay client-side because Rust decodes none of them.
// "none" covers every directory arm, an undecryptable file, a pdf or svg over its size gate, and
// anything the SDK itself says it cannot thumbnail.
export type ThumbnailCategory = "sdk" | "video" | "pdf" | "svg" | "none"

// The thumbnail's width bound, shared by every producer — one target keeps every cached .thumb file
// roughly the same size. The video and pdf generators use it for both dimensions (a square fit), the
// svg one for its long side, and the SDK arm pairs it with THUMB_SDK_MAX_HEIGHT below instead, for the
// reason documented there.
//
// 384 is sized to the largest tile this app renders, not the smallest: the photos grid's density
// steps top out at a 320px tile (gridDensity.ts), which is 640 real pixels at 2x DPR. The old 256
// was an upscale even in the drive grid's fixed 176px tile. It is affordable only because the SDK
// arm now encodes lossy (THUMB_SDK_LOSSY_QUALITY) — see that constant.
export const THUMB_MAX_DIM = 384

// The SDK's own thumbnail request is 384x768, NOT square, and the asymmetry is deliberate. The SDK
// accepts an image's embedded preview (an EXIF IFD1 stamp, a HEIF `thmb` item) instead of decoding
// the full frame when `preview_long_side * 2 >= max(maxWidth, maxHeight)` — so asking for a square
// 384 would accept a 192px stamp, mush in a tile twice that size. Doubling only the height raises
// that acceptance bar to a 384px preview without changing what the result gets scaled to: nothing is
// ever upscaled, and fitting a landscape photo inside 384x768 still lands on a 384px-wide thumbnail.
// The bar is deliberately above the ~320px HEIC `thmb`, which now costs a full decode; a RAW's
// full-size embedded JPEG clears it and still answers in a couple of range reads.
export const THUMB_SDK_MAX_HEIGHT = THUMB_MAX_DIM * 2

// Whole-buffer decode/generate ceiling (64 MiB) for the ONE remaining category that pulls the entire
// file into JS memory to produce a thumbnail: pdf. An oversize file skips thumbnailing rather than
// risking a tab-crashing allocation for a preview-sized image. video is exempt (its generator only
// ever reads a single frame off a stream), and so is "sdk" — the SDK enforces its own byte ceiling
// (`max_source_bytes`, 64 MiB by default, byte-identical to this) internally, and still runs the cheap
// embedded-preview probe ABOVE it. Applying this gate to the sdk arm would therefore change nothing
// except to throw away the one case that matters most: a 90 MB RAW whose camera already embedded a
// full-size JPEG the SDK can lift out with a couple of range reads.
export const THUMB_SIZE_GATE = 67_108_864n

// Whole-document ceiling (4 MiB) for an svg, which is read whole and parsed and rasterised on the main
// thread (only a DOM <img> renders one). Real icons and illustrations sit far below it; past it lies
// map or plot data whose parse and paint would stall the page for a tile-sized picture.
export const THUMB_SVG_SIZE_GATE = 4_194_304n

// The working memory the SDK allots one thumbnail decode (microthumb's APP_PROCESS_MEM_BUDGET). A
// different axis from THUMB_SIZE_GATE above — bytes of MEMORY, not bytes of source — that happens to
// default to the same 64 MiB. This app configures neither.
const THUMB_SDK_MEM_BUDGET = 67_108_864n

// microthumb prices a decode target at 40 bytes for every pixel of the square it would have to hold:
// `affordable_target(budget) = sqrt(budget / 40)`. Both requested dimensions are clamped to that
// affordable target BEFORE a decoder commits to an output size, and nothing is upscaled afterwards, so
// a request survives at the size it asked for only while the budget can still afford its LONGEST side.
const THUMB_TARGET_BUDGET_BYTES_PER_PX = 40n

// What must remain of the budget for a whole 384x768 request to come back unclamped: 768^2 * 40, 22.5 MiB.
const THUMB_FULL_TARGET_BUDGET = BigInt(THUMB_SDK_MAX_HEIGHT) * BigInt(THUMB_SDK_MAX_HEIGHT) * THUMB_TARGET_BUDGET_BYTES_PER_PX

// Ceiling (41.5 MiB) on a LOCAL source handed to the SDK's from-stream thumbnail path, which buffers
// the source whole and takes its length off the decode budget above. Past this what is left can no
// longer afford the full 384x768 request, so that path does not fail — it quietly returns a SMALLER
// thumbnail (a 63 MiB source leaves ~1 MiB, good for ~160px). The larger request box tightened this
// gate from 54 MiB, so more just-uploaded files now fall through to the drive-side producer. The drive-side path pays a constant 3 MiB for its
// resident chunk slots instead — two on-demand slots plus the hand-off slot of the read-ahead stream a
// full decode switches to — so its budget never shrinks with the file; past this gate it is simply the
// better producer. Below THUMB_SIZE_GATE, so it also covers the from-stream path's outright refusal of
// a source over `max_source_bytes`.
export const THUMB_WARM_SIZE_GATE = THUMB_SDK_MEM_BUDGET - THUMB_FULL_TARGET_BUDGET

// WebP quality 0-100 handed to the SDK arm. Absent would mean LOSSLESS (the SDK's default), which is
// what a 384x768 box could not afford: lossy runs several times smaller on photographic content, and
// that is what pays for the larger request without growing each cache entry. It matters most here
// because THUMB_CACHE_CAP is a HARD cap with LRU eviction — bytes per entry is exactly how many
// thumbnails a large library gets to keep, and every eviction costs a fresh range read plus a decode.
// 80 is where WebP artefacts stop being visible at tile size.
export const THUMB_SDK_LOSSY_QUALITY = 80

// On-disk cache ceiling (256 MiB) — sweepThumbs evicts the oldest entries once the store exceeds
// this, so a long-lived session's thumbnail cache never grows unbounded.
export const THUMB_CACHE_CAP = 268_435_456

// Parent OPFS directory holding every thumbnail-cache generation, each as its own child directory —
// removeStaleThumbGenerations (thumbStore.ts) walks this root's children to evict everything that
// isn't THUMB_GENERATION, so a format change reclaims the old bytes instead of leaking them forever.
export const THUMB_DIR_ROOT = ["thumbnails"]

// Bumped whenever the cached bytes themselves change shape (a different max dimension, a different
// encode, a different PRODUCER) — "v1" -> "v2" was the 512 -> 256 THUMB_MAX_DIM drop; "v2" -> "v3" is
// the still-image producer changing from a browser createImageBitmap decode to the SDK's own webp
// encode; "v3" -> "v4" is THUMB_MAX_DIM 256 -> 384 with the SDK arm's encode going lossy. A stale
// generation can never serve under the new code, and removeStaleThumbGenerations reclaims the
// superseded bytes on the next sweep rather than leaking them.
export const THUMB_GENERATION = "v4"

// OPFS path segments under the origin's private root for the live generation's own cache tree.
export const THUMB_DIR = [...THUMB_DIR_ROOT, THUMB_GENERATION]

export const THUMB_EXT = ".thumb"

// Category routing over every file-family arm — owned, shared-root and nested shared files alike
// (asDirectoryOrFile). A shared file carries the same decrypted meta and the SDK's own
// canMakeThumbnail, and the SDK thumbnails any AnyFile, so a shared file routes exactly like an owned
// one. A directory arm always resolves "none", same as an undecryptable file.
//
// The ORDER below is load-bearing, not cosmetic. Video and pdf both carry `canMakeThumbnail: false`
// (the SDK decodes neither), so if the sdk arm were checked first they would fall to "none" and lose
// the client-side generators that DO handle them — they have to be claimed by extension first.
//
//   1. directory / undecryptable -> none   (nothing to route on)
//   2. svg, at/under the gate    -> svg    (client-side: rasterised through an <img>, whose secure
//                                           mode runs no script; never handed to the SDK's decoders)
//   3. video extension           -> video  (client-side: one frame off the SW's Range stream)
//   4. pdf, at/under the gate    -> pdf    (client-side: pdf.js, the one whole-buffer decode left)
//   5. canMakeThumbnail === true -> sdk    (every still image; the SDK's own answer, never guessed)
//   6. everything else           -> none
//
// Step 5 is the SINGLE SOURCE OF TRUTH for SDK thumbnailability — there is deliberately no extension
// allowlist mirroring it here. The flag comes off the file the SDK itself decrypted, so it already
// accounts for formats this app has never heard of, and duplicating it as a JS list would only create
// a second answer that can drift.
export function thumbnailCategory(item: DriveItem): ThumbnailCategory {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return "none"
	}

	const ext = itemTypeExtension(item)

	if (ext === "svg") {
		return base.data.size <= THUMB_SVG_SIZE_GATE ? "svg" : "none"
	}

	if (previewCategoryForExtension(ext) === "video") {
		return "video"
	}

	if (ext === "pdf") {
		return base.data.size <= THUMB_SIZE_GATE ? "pdf" : "none"
	}

	return base.data.canMakeThumbnail ? "sdk" : "none"
}

// A thumbnail handed from one uuid to another: a copied file holds its source's content, so its
// thumbnail is the source's too.
export interface ThumbnailCopy {
	from: string
	to: string
}

// name/size/lastModified projection of one cached .thumb file — thumbStore.ts's listThumbs() own
// return shape. Oldest-first eviction over this shape is planSizeCapEviction from @filen/shared
// (thumbStore.ts maps {name,size,lastModified} to {id,size,timestamp} at the call site).
export interface ThumbCacheEntry {
	name: string
	size: number
	lastModified: number
}

// A virtualizer's visible rows, overscan excluded (TanStack Virtual's `range`); null before it has a size.
export interface VisibleRows {
	startIndex: number
	endIndex: number
}

const ABOVE_VIEW_RANK = 1_000_000

// Where a cell's thumbnail generation queues (see RankedGate): visible rows first, then the rows below,
// nearest first, and the rows above last, since they are behind the direction a grid is read in. No
// range yet ranks every row as visible, which leaves plain arrival order.
export function rowRank(row: number, visible: VisibleRows | null): number {
	if (visible === null || (row >= visible.startIndex && row <= visible.endIndex)) {
		return 0
	}

	return row > visible.endIndex ? row - visible.endIndex : ABOVE_VIEW_RANK + visible.startIndex - row
}

// How many image thumbnails the SDK decodes at once: its pool of decode workers on the web, each holding up
// to THUMB_SDK_MEM_BUDGET while it runs and never handing its memory back to the tab. Boot passes it as the
// client's thumbnailDecodeConcurrency, and the generation gate for image thumbnails is sized by it.
export const SDK_THUMBNAIL_DECODES = 3
