import { matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { IMAGE_VIEWER_ACTIONS, type ImageViewerAction } from "@/features/preview/lib/keymap"
import { browserZoomKey, zoomKeyAction, type BrowserZoomKey } from "@/lib/keymap/browserZoom"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { clampImageScale, clampPan, containSize, type Size, type ZoomTransform } from "@/features/preview/components/imageViewer.logic"

const ZOOM_ACTIONS: Readonly<Record<BrowserZoomKey, ImageViewerAction>> = {
	in: "preview.imageZoomIn",
	out: "preview.imageZoomOut",
	reset: "preview.imageZoomFit"
}

const PAN_ACTIONS: ReadonlySet<ImageViewerAction> = new Set([
	"preview.imagePanLeft",
	"preview.imagePanRight",
	"preview.imagePanUp",
	"preview.imagePanDown"
])

// The image viewer action a keydown is under `combos` (the combos in effect by id, useBindings), as the PDF viewer
// matches its own (the browser's zoom keys by character first). The pan keys only while the image is zoomed in, where
// there is something to move: at fit the arrows stay the pager's.
export function imageViewerKey(
	event: ChordEvent,
	combos: Readonly<Record<string, string>>,
	zoomed: boolean,
	mac: boolean = isMacPlatform()
): ImageViewerAction | undefined {
	const zoom = browserZoomKey(event, mac)

	if (zoom !== undefined) {
		return zoomKeyAction(event, IMAGE_VIEWER_ACTIONS, ZOOM_ACTIONS[zoom], combos, mac)
	}

	return IMAGE_VIEWER_ACTIONS.find(
		def => (zoomed || !PAN_ACTIONS.has(def.id)) && matchesCombo(event, combos[def.id] ?? def.defaultCombo, mac)
	)?.id
}

// One zoom key step, as a browser's.
export const IMAGE_KEY_ZOOM_FACTOR = 1.25
// One pan key step, a share of the view.
export const IMAGE_KEY_PAN_SHARE = 0.1

const AT_FIT: ZoomTransform = { scale: 1, x: 0, y: 0 }

// The transform an action leaves, from `current` in a view of `container` showing an image of `natural` (null before it
// has loaded). Zoom keys zoom about the view's centre; back at fit or below, the pan resets, as the wheel's does.
export function imageKeyTransform(action: ImageViewerAction, current: ZoomTransform, container: Size, natural: Size | null): ZoomTransform {
	const fitted = natural === null ? container : containSize(container, natural)
	const rescale = (scale: number): ZoomTransform => {
		const next = clampImageScale(scale)

		if (next <= 1) {
			return { scale: next, x: 0, y: 0 }
		}

		const ratio = next / current.scale

		return { scale: next, ...clampPan(container, fitted, next, { x: current.x * ratio, y: current.y * ratio }) }
	}
	const pan = (dx: number, dy: number): ZoomTransform => ({
		...current,
		...clampPan(container, fitted, current.scale, {
			x: current.x + dx * container.width * IMAGE_KEY_PAN_SHARE,
			y: current.y + dy * container.height * IMAGE_KEY_PAN_SHARE
		})
	})

	switch (action) {
		case "preview.imageZoomIn":
			return rescale(current.scale * IMAGE_KEY_ZOOM_FACTOR)
		case "preview.imageZoomOut":
			return rescale(current.scale / IMAGE_KEY_ZOOM_FACTOR)
		case "preview.imageZoomFit":
			return AT_FIT
		case "preview.imageActualSize":
			// One image pixel per CSS pixel: the fitted box is the image shrunk to fit, never grown.
			return natural === null || fitted.width <= 0 ? current : rescale(natural.width / fitted.width)
		// As a scroll: left shows more of the image's left side, so the image moves right.
		case "preview.imagePanLeft":
			return pan(1, 0)
		case "preview.imagePanRight":
			return pan(-1, 0)
		case "preview.imagePanUp":
			return pan(0, 1)
		case "preview.imagePanDown":
			return pan(0, -1)
	}
}
