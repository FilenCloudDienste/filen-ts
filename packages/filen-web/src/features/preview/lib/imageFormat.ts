import type { DeviceProfile } from "@/lib/deviceProfile"
import type { NativeImageFormat } from "@/lib/nativeImageSupport"

// How each image extension is shown: by the browser itself ("native", streamed through the service worker's inline
// route), or decoded from its whole bytes first by our own code in the raster decode pool ("heic" in libheif, "qoi",
// "jxl" in libjxl). HEIC and JPEG XL stream like a native image where a probe found the browser decodes them. The image
// tier of the preview's category table is this table's keys.
export type ImageDecode = "native" | "heic" | "qoi" | "jxl"

export interface ImageFormat {
	decode: ImageDecode
	// The raster editor opens it.
	editable: boolean
	// Largest file the preview opens, ahead of the image category's own limit; null from a function for none.
	cap?: bigint | ((profile: DeviceProfile) => bigint | null)
	// Shown in Photos; absent for the image category's own answer (yes).
	photo?: boolean
}

const MIB = 1024n * 1024n

const NATIVE_EDITABLE: ImageFormat = { decode: "native", editable: true }
// HEIC/HEIF. "hif" is Fujifilm's extension for the same container, written 10-bit 4:2:2; libheif decodes high-bit-depth
// HEVC and hands back 8-bit RGBA like any other HEIC.
const HEIC: ImageFormat = { decode: "heic", editable: true }
// Held whole and decoded in the raster decode pool.
const QOI: ImageFormat = { decode: "qoi", editable: true, cap: 256n * MIB }
// Streamed where the browser decodes it; elsewhere held whole (its cap) and decoded by libjxl in the pool.
const JXL: ImageFormat = { decode: "jxl", editable: true, cap: 256n * MIB }

export const IMAGE_FORMATS: ReadonlyMap<string, ImageFormat> = new Map<string, ImageFormat>([
	["jpg", NATIVE_EDITABLE],
	["jpeg", NATIVE_EDITABLE],
	// JPEG under the names older tools and browsers save it as.
	["jfif", NATIVE_EDITABLE],
	["jpe", NATIVE_EDITABLE],
	["pjpeg", NATIVE_EDITABLE],
	["pjp", NATIVE_EDITABLE],
	["png", NATIVE_EDITABLE],
	["gif", NATIVE_EDITABLE],
	["webp", NATIVE_EDITABLE],
	// Markup, not pixels: never the raster editor.
	["svg", { decode: "native", editable: false }],
	["bmp", NATIVE_EDITABLE],
	["ico", NATIVE_EDITABLE],
	["apng", NATIVE_EDITABLE],
	["avif", NATIVE_EDITABLE],
	["heic", HEIC],
	["heif", HEIC],
	["hif", HEIC],
	["qoi", QOI],
	["jxl", JXL]
])

// The extensions whose bytes are a HEIF container, by name.
export const HEIC_EXTENSIONS: ReadonlySet<string> = new Set(
	[...IMAGE_FORMATS].filter(([, format]) => format.decode === "heic").map(([extension]) => extension)
)

// Whether this browser shows the format from the service worker's stream, uncapped like every native image. The one
// rule for the open gate, the viewer's routing and the inline content type.
export function streamsNatively(format: ImageFormat, profile: DeviceProfile): boolean {
	switch (format.decode) {
		case "native":
			return true
		case "heic":
			return profile.heicNative === "yes"
		case "jxl":
			return profile.jxlNative === "yes"
		case "qoi":
			return false
	}
}

// Whether a format counts as a photo (Photos lists it).
export function isPhotoFormat(format: ImageFormat): boolean {
	return format.photo ?? true
}

// The probe whose answer picks the format's route while it is still unknown: a viewer waits on it rather than take the
// decoded route an unknown answer reads as.
export function pendingProbe(format: ImageFormat, profile: DeviceProfile): NativeImageFormat | null {
	switch (format.decode) {
		case "heic":
			return profile.heicNative === "unknown" ? "heic" : null
		case "jxl":
			return profile.jxlNative === "unknown" ? "jxl" : null
		default:
			return null
	}
}
