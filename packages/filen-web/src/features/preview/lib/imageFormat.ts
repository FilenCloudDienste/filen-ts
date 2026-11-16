import type { DeviceProfile } from "@/lib/deviceProfile"

// How each image extension is shown: by the browser itself ("native", streamed through the service worker's inline
// route), or decoded from its whole bytes first ("heic", in libheif). The image tier of the preview's category table
// is this table's keys.
export type ImageDecode = "native" | "heic"

export interface ImageFormat {
	decode: ImageDecode
	// The raster editor opens it.
	editable: boolean
	// Largest file the preview opens, ahead of the image category's own limit; null from a function for none.
	cap?: bigint | ((profile: DeviceProfile) => bigint | null)
}

const NATIVE_EDITABLE: ImageFormat = { decode: "native", editable: true }
// HEIC/HEIF. "hif" is Fujifilm's extension for the same container, written 10-bit 4:2:2; libheif decodes high-bit-depth
// HEVC and hands back 8-bit RGBA like any other HEIC.
const HEIC: ImageFormat = { decode: "heic", editable: true }

export const IMAGE_FORMATS: ReadonlyMap<string, ImageFormat> = new Map<string, ImageFormat>([
	["jpg", NATIVE_EDITABLE],
	["jpeg", NATIVE_EDITABLE],
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
	["hif", HEIC]
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
	}
}
