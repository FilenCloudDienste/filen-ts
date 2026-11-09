import type { Bounds } from "@filen/office/react/presentation"

// The slide canvas menu's pure parts: the keys that open it (the show's own, one definition) and where a key opens it.

export { isContextMenuKey } from "@filen/office/react/presentation"

// Where a key opens the menu (client px): the centre of the selection's bounds (EMU), else of the slide, inside the
// slide's frame as it lies on the page.
export function contextMenuPoint(
	frame: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
	size: { readonly cx: number; readonly cy: number },
	bounds: readonly Bounds[]
): { readonly x: number; readonly y: number } {
	if (bounds.length === 0 || size.cx <= 0 || size.cy <= 0) return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 }

	let x = Infinity
	let y = Infinity
	let r = -Infinity
	let b = -Infinity

	for (const box of bounds) {
		x = Math.min(x, box.x)
		y = Math.min(y, box.y)
		r = Math.max(r, box.r)
		b = Math.max(b, box.b)
	}

	const clamp = (value: number): number => Math.min(1, Math.max(0, value))

	return {
		x: frame.left + clamp((x + r) / 2 / size.cx) * frame.width,
		y: frame.top + clamp((y + b) / 2 / size.cy) * frame.height
	}
}
