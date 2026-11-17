import { MUPDF_BYTES_PER_PIXEL, PDF_DESKTOP_MEMORY, PDF_HEAP_BASELINE, PDF_MOBILE_MEMORY } from "@filen/office/core/pdfedit"
import { THUMB_SDK_MEM_BUDGET } from "@/features/drive/lib/thumbnails.logic"
import type { DeviceProfile } from "@/lib/deviceProfile"
import { pdfViewerLimits } from "@/features/preview/lib/pdfLimits"

// The pixel budgets every decode of untrusted image bytes checks, each with its basis. A decode compares the dimensions
// its header names (read from bytes already in hand) against its budget before it allocates anything. Workers never
// read the device profile: the page computes the number and sends it with the request.

const MIB = 1024 * 1024

// A decode by our own code (a wasm or JS decoder) into a worker heap: about half of wasm's 2 GiB ceiling on desktop,
// leaving room for the file and the module; a phone's tab is killed far sooner.
const WORKER_DECODE_BYTES_DESKTOP = 1024 * MIB
const WORKER_DECODE_BYTES_MOBILE = 384 * MIB

// A thumbnail decode works in the SDK's per-decode memory, at 4 bytes (RGBA) a pixel.
const THUMBNAIL_BYTES_PER_PIXEL = 4

// The image editor's largest source: its RGBA buffer, the encoder's copy and the GPU tiles must fit a tab. iOS and
// iPadOS kill a tab far sooner than other engines do.
const EDIT_PIXELS = 50_000_000
const EDIT_PIXELS_APPLE_MOBILE = 16_000_000

// The long side an image our own code decodes is first shown at (its full resolution is a click away): what a large
// screen shows of it at fit, without the decoded frame's whole cost on the GPU.
const DISPLAY_LONG_SIDE_DESKTOP = 4096
const DISPLAY_LONG_SIDE_MOBILE = 2048

export function displayLongSide(profile: DeviceProfile): number {
	return profile.mobile ? DISPLAY_LONG_SIDE_MOBILE : DISPLAY_LONG_SIDE_DESKTOP
}

// The most pixels a canvas of this device holds (the viewers' own canvas area limit, 4 bytes a pixel): what an image is
// drawn at, at most, however many our decoders could decode.
export function canvasPixels(): number {
	return Math.floor(pdfViewerLimits().canvasMaxAreaInBytes / 4)
}

export function workerDecodeBytes(profile: DeviceProfile): number {
	return profile.mobile ? WORKER_DECODE_BYTES_MOBILE : WORKER_DECODE_BYTES_DESKTOP
}

// What remains of the worker budget once the file is held, at the consumer's own bytes per pixel (its decoded frame
// plus every copy it makes of it).
export function workerDecodePixels(profile: DeviceProfile, fileBytes: number, bytesPerPixel: number): number {
	return Math.max(0, Math.floor((workerDecodeBytes(profile) - fileBytes) / bytesPerPixel))
}

// One image page decoded by MuPDF, at its measured bytes per pixel (core/pdfedit/budget.ts). The engine reads an image
// file whole into the same heap that holds the decoded page, so the file counts against it; `fileBytes` is 0 for a
// format it reads lazily.
export function mupdf(profile: DeviceProfile, fileBytes: number): number {
	const heapBudget = (profile.mobile ? PDF_MOBILE_MEMORY : PDF_DESKTOP_MEMORY).heapBudget

	return Math.max(0, Math.floor((heapBudget - PDF_HEAP_BASELINE - fileBytes) / MUPDF_BYTES_PER_PIXEL))
}

export function thumbnail(): number {
	return Number(THUMB_SDK_MEM_BUDGET) / THUMBNAIL_BYTES_PER_PIXEL
}

export function edit(profile: DeviceProfile): number {
	return profile.appleMobile ? EDIT_PIXELS_APPLE_MOBILE : EDIT_PIXELS
}
