import type { MarkupColor } from "@/features/preview/imageEdit/types"

// The markup tools' settings: palette, widths and sizes, and the screen↔source mapping the drawing layer works in.

export type MarkupTool = "pen" | "highlighter" | "arrow" | "text" | "eraser"

export type MarkupWidth = 0 | 1 | 2

// The markup palette, in swatch order.
export const MARKUP_COLORS: readonly { color: MarkupColor; labelKey: ColorLabelKey }[] = [
	{ color: "#ef4444", labelKey: "previewImageEditColorRed" },
	{ color: "#f97316", labelKey: "previewImageEditColorOrange" },
	{ color: "#facc15", labelKey: "previewImageEditColorYellow" },
	{ color: "#22c55e", labelKey: "previewImageEditColorGreen" },
	{ color: "#3b82f6", labelKey: "previewImageEditColorBlue" },
	{ color: "#a855f7", labelKey: "previewImageEditColorPurple" },
	{ color: "#000000", labelKey: "previewImageEditColorBlack" },
	{ color: "#ffffff", labelKey: "previewImageEditColorWhite" }
]

type ColorLabelKey =
	| "previewImageEditColorRed"
	| "previewImageEditColorOrange"
	| "previewImageEditColorYellow"
	| "previewImageEditColorGreen"
	| "previewImageEditColorBlue"
	| "previewImageEditColorPurple"
	| "previewImageEditColorBlack"
	| "previewImageEditColorWhite"

// Stroke widths and text sizes as fractions of the source's longer side, so they look alike on any resolution.
const STROKE_FRACTIONS: readonly [number, number, number] = [0.004, 0.008, 0.016]
const TEXT_FRACTIONS: readonly [number, number, number] = [0.03, 0.045, 0.065]
// A highlighter is a broad marker.
const HIGHLIGHTER_SCALE = 3
export const HIGHLIGHTER_ALPHA = 0.35

export function strokeWidth(width: MarkupWidth, tool: "pen" | "highlighter" | "arrow", longerSide: number): number {
	return STROKE_FRACTIONS[width] * longerSide * (tool === "highlighter" ? HIGHLIGHTER_SCALE : 1)
}

export function textSize(width: MarkupWidth, longerSide: number): number {
	return TEXT_FRACTIONS[width] * longerSide
}

// Mapping between the frame (screen px from the picture's top left) and the upright source's pixels.
export interface MarkupMapping {
	toSource: (x: number, y: number) => readonly [number, number]
	toScreen: (x: number, y: number) => readonly [number, number]
	// Screen px per source px.
	scale: number
}
