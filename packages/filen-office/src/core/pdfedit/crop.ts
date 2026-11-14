import { parsePageRanges } from "./pageRanges"

// Crop geometry: rects are [x0, y0, x1, y1] in a page's view space (points, y down, the page's rotation applied, the
// visible box starting at 0,0), the space MuPDF's page bounds and setPageBox use. Margins are what a crop takes off each
// side of that visible box, so one choice applies to pages of different sizes.

export type CropRect = readonly [number, number, number, number]

export interface CropMargins {
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
}

// The smallest crop side (points): a crop never leaves less of a page than this.
export const MIN_CROP_SIDE = 18

export const NO_MARGINS: CropMargins = { left: 0, top: 0, right: 0, bottom: 0 }

export function cropWidth(rect: CropRect): number {
	return rect[2] - rect[0]
}

export function cropHeight(rect: CropRect): number {
	return rect[3] - rect[1]
}

// The crop `margins` leave of `bounds`, or null when they leave less than MIN_CROP_SIDE either way.
export function cropRectFromMargins(bounds: CropRect, margins: CropMargins): CropRect | null {
	const rect: CropRect = [
		bounds[0] + Math.max(0, margins.left),
		bounds[1] + Math.max(0, margins.top),
		bounds[2] - Math.max(0, margins.right),
		bounds[3] - Math.max(0, margins.bottom)
	]

	return cropWidth(rect) < MIN_CROP_SIDE || cropHeight(rect) < MIN_CROP_SIDE ? null : rect
}

// The margins that crop `bounds` to `rect` (clamped inside it).
export function marginsFromRect(bounds: CropRect, rect: CropRect): CropMargins {
	const inner = clampCropRect(bounds, rect)

	return { left: inner[0] - bounds[0], top: inner[1] - bounds[1], right: bounds[2] - inner[2], bottom: bounds[3] - inner[3] }
}

// `rect` ordered, inside `bounds`, and at least MIN_CROP_SIDE (or the bounds' side when smaller) each way.
export function clampCropRect(bounds: CropRect, rect: CropRect): CropRect {
	const minWidth = Math.min(MIN_CROP_SIDE, cropWidth(bounds))
	const minHeight = Math.min(MIN_CROP_SIDE, cropHeight(bounds))
	let x0 = Math.max(bounds[0], Math.min(rect[0], rect[2]))
	let y0 = Math.max(bounds[1], Math.min(rect[1], rect[3]))
	let x1 = Math.min(bounds[2], Math.max(rect[0], rect[2]))
	let y1 = Math.min(bounds[3], Math.max(rect[1], rect[3]))

	if (x1 - x0 < minWidth) {
		x1 = Math.min(bounds[2], x0 + minWidth)
		x0 = x1 - minWidth
	}

	if (y1 - y0 < minHeight) {
		y1 = Math.min(bounds[3], y0 + minHeight)
		y0 = y1 - minHeight
	}

	return [x0, y0, x1, y1]
}

// `content` grown by `padding` on every side, inside `bounds`; null for empty content (a blank page keeps its box).
export function paddedContent(bounds: CropRect, content: CropRect | null, padding: number): CropRect | null {
	if (content === null || cropWidth(content) <= 0 || cropHeight(content) <= 0) return null

	return clampCropRect(bounds, [content[0] - padding, content[1] - padding, content[2] + padding, content[3] + padding])
}

// The parts of `outer` outside `inner`: up to four rects (top and bottom bands full width, the sides between them),
// what "Remove content outside the crop" marks for redaction.
export function outsideRects(outer: CropRect, inner: CropRect): CropRect[] {
	const x0 = Math.max(outer[0], Math.min(outer[2], inner[0]))
	const y0 = Math.max(outer[1], Math.min(outer[3], inner[1]))
	const x1 = Math.max(x0, Math.min(outer[2], inner[2]))
	const y1 = Math.max(y0, Math.min(outer[3], inner[3]))
	const rects: CropRect[] = []

	if (y0 > outer[1]) rects.push([outer[0], outer[1], outer[2], y0])
	if (y1 < outer[3]) rects.push([outer[0], y1, outer[2], outer[3]])
	if (x0 > outer[0] && y1 > y0) rects.push([outer[0], y0, x0, y1])
	if (x1 < outer[2] && y1 > y0) rects.push([x1, y0, outer[2], y1])

	return rects
}

export type CropScope =
	| { readonly kind: "current" }
	| { readonly kind: "selected" }
	| { readonly kind: "all" }
	| { readonly kind: "odd" }
	| { readonly kind: "even" }
	| { readonly kind: "range"; readonly text: string }

// The 0-based pages a crop applies to, or null when a typed range cannot be read. `current` is 0-based; `selected`
// holds the rail's selection (the current page when empty). Odd and even count pages from 1.
export function cropScopePages(scope: CropScope, count: number, current: number, selected: readonly number[]): number[] | null {
	const all = (keep: (page: number) => boolean): number[] => {
		const pages: number[] = []

		for (let page = 0; page < count; page++) if (keep(page)) pages.push(page)

		return pages
	}

	switch (scope.kind) {
		case "current":
			return current >= 0 && current < count ? [current] : []
		case "selected": {
			const pages = [...new Set(selected)].filter(page => page >= 0 && page < count).sort((a, b) => a - b)

			return pages.length > 0 ? pages : cropScopePages({ kind: "current" }, count, current, [])
		}
		case "all":
			return all(() => true)
		case "odd":
			return all(page => page % 2 === 0)
		case "even":
			return all(page => page % 2 === 1)
		case "range": {
			const parsed = parsePageRanges(scope.text, count)

			if (!parsed.ok) return null

			return parsed.ranges.flatMap(range => Array.from({ length: range.last - range.first + 1 }, (_, at) => range.first - 1 + at))
		}
	}
}

export type CropHandle = "move" | "top" | "bottom" | "left" | "right" | "topLeft" | "topRight" | "bottomLeft" | "bottomRight"

// A crop rect after one keyboard step: arrows move the handle (the whole rect for "move") by `step` points, then the
// result is clamped inside `bounds`. Unknown keys return undefined.
export function nudgeCropRect(bounds: CropRect, rect: CropRect, handle: CropHandle, key: string, step: number): CropRect | undefined {
	const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0
	const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0

	if (dx === 0 && dy === 0) return undefined

	return dragCropHandle(bounds, rect, handle, dx, dy)
}

// A crop rect with `handle` dragged by (dx, dy) points; edges never cross (the rect keeps MIN_CROP_SIDE) and stay
// inside `bounds`.
export function dragCropHandle(bounds: CropRect, rect: CropRect, handle: CropHandle, dx: number, dy: number): CropRect {
	if (handle === "move") {
		const x = Math.max(bounds[0] - rect[0], Math.min(bounds[2] - rect[2], dx))
		const y = Math.max(bounds[1] - rect[1], Math.min(bounds[3] - rect[3], dy))

		return [rect[0] + x, rect[1] + y, rect[2] + x, rect[3] + y]
	}

	const side = Math.min(MIN_CROP_SIDE, cropWidth(bounds), cropHeight(bounds))
	let [x0, y0, x1, y1] = rect

	if (handle === "left" || handle === "topLeft" || handle === "bottomLeft") x0 = Math.max(bounds[0], Math.min(x1 - side, x0 + dx))
	if (handle === "right" || handle === "topRight" || handle === "bottomRight") x1 = Math.min(bounds[2], Math.max(x0 + side, x1 + dx))
	if (handle === "top" || handle === "topLeft" || handle === "topRight") y0 = Math.max(bounds[1], Math.min(y1 - side, y0 + dy))
	if (handle === "bottom" || handle === "bottomLeft" || handle === "bottomRight") y1 = Math.min(bounds[3], Math.max(y0 + side, y1 + dy))

	return [x0, y0, x1, y1]
}
