// The DOM dxf-viewer reaches for, stubbed for the CAD worker, which has none: the one place these stubs live. Checked
// against dxf-viewer 1.0.51 (pinned exactly); re-check on every bump.
//
// - DxfViewer's constructor reads `window.devicePixelRatio` for the renderer, and its container's
//   clientWidth/clientHeight/style/appendChild; the renderer's setSize writes the canvas's `style`.
// - Its OrbitControls compare their element with the free identifier `document` when built, and add and remove
//   listeners on `element.ownerDocument` in dispose() and on pointer events (which never reach an OffscreenCanvas).

export interface DxfContainerStub {
	readonly clientWidth: number
	readonly clientHeight: number
	readonly style: Record<string, string>
	appendChild(): void
}

export type DxfCanvasStub<Canvas> = Canvas & { style: Record<string, string>; ownerDocument: EventTarget }

// Sizes reach the viewer in backing pixels already, so the ratio it scales them by is 1.
export const DXF_DEVICE_PIXEL_RATIO = 1

// Worker globals only: never called on the page. `document` holds undefined, so `typeof document` still says
// "undefined" to everything else that asks.
export function installDxfGlobals(): void {
	Object.assign(globalThis, { window: { devicePixelRatio: DXF_DEVICE_PIXEL_RATIO } })

	if (!("document" in globalThis)) {
		Object.assign(globalThis, { document: undefined })
	}
}

// The container the viewer would put its canvas in: the canvas already lives in the page's shell.
export function dxfContainer(width: number, height: number): DxfContainerStub {
	return { clientWidth: width, clientHeight: height, style: {}, appendChild: () => undefined }
}

// The canvas given inert `style` and `ownerDocument` expandos.
export function dxfCanvas<Canvas extends object>(canvas: Canvas): DxfCanvasStub<Canvas> {
	return Object.assign(canvas, { style: {}, ownerDocument: new EventTarget() })
}
