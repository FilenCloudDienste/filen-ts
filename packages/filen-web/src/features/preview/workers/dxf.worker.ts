/// <reference lib="webworker" />
// Installed below, before a drawing is read: the fetch shim and the DOM stubs dxf-viewer reaches for.
import { installResourceSandbox } from "@/lib/workers/resourceSandbox"
import { dxfCanvas, installDxfGlobals } from "@/features/preview/lib/dxfStubs"
import * as Comlink from "comlink"
import { Color, Vector3, WebGLRenderer } from "three"
import type { DxfViewer } from "dxf-viewer"
import { OFFICE_PDF_FONT_URLS } from "virtual:office-pdf-fonts"
import { FALLBACK_FAMILIES, PDF_FACES, decodeFace, type PdfFaceFile } from "@filen/office/core/pdfwrite/fonts"
import { DXF_MAX_BYTES } from "@/features/preview/lib/previewCaps"
import { DXF_HEADER_BYTES, dxfFileEncoding } from "@/features/preview/lib/dxfEncoding.logic"
import { DxfCodePoints, dxfFontFaces, regularFace } from "@/features/preview/lib/dxfFonts.logic"
import { panDxfView, zoomDxfView, type DxfView } from "@/features/preview/lib/dxfView.logic"
import {
	DXF_DRAWING_PATH,
	DXF_FONT_PATH_PREFIX,
	createDxfViewer,
	dxfLoadFailure,
	loadDxf,
	watchDxfMessages
} from "@/features/preview/lib/dxfScene"
import { IMAGE_WHEEL_SENSITIVITY } from "@/features/preview/components/imageViewer.logic"
import type { CanvasInput, ShellToWorker, WorkerToShell } from "@/features/preview/components/canvasViewerShell.logic"

// One DXF drawing, owned by its viewer: dxf-viewer parses it and builds its scene in this worker (no worker of its own)
// and draws into the shell's OffscreenCanvas, only when something changed (load, resize, view, a layer, the
// background, a restore). The view is panned and zoomed from the shell's input; the viewer's own controls listen on a
// canvas no DOM event reaches. A lost context is restored by three over the retained scene; one that is not gets a
// fresh worker (the viewer cannot move its scene to a new renderer).

// Layers listed in the panel at most; the rest are counted.
const DXF_MAX_LISTED_LAYERS = 1000

const KEY_PAN = 64
const KEY_ZOOM = 1.25
const BACKGROUNDS = { dark: new Color(0x000000), light: new Color(0xffffff) }

export interface DxfLayer {
	// What ShowLayer takes.
	readonly name: string
	readonly label: string
	// CSS colour, as drawn against the background at load.
	readonly color: string
	readonly visible: boolean
}

export type DxfStatus = "ready" | "empty" | "tooComplex" | "malformed" | "noWebgl"

// One shape for every outcome: Comlink's remote type does not keep a union's arms apart.
export interface DxfLoad {
	readonly status: DxfStatus
	readonly layers: readonly DxfLayer[]
	// Layers past DXF_MAX_LISTED_LAYERS.
	readonly moreLayers: number
	// Some text has characters no bundled font draws.
	readonly missingGlyphs: boolean
	// Malformed entities left out.
	readonly skipped: number
}

// The worker asks its viewer for a fresh worker: a lost display did not come back and a new canvas arrived.
export type DxfShellStatus = "restart"

const primaryFace = regularFace(PDF_FACES.arimo)

if (primaryFace === undefined) throw new Error("The bundled sans face is missing")

const fallbackFaces = FALLBACK_FAMILIES.flatMap(family => regularFace(family.faces) ?? [])
const fontUrls = new Map(
	[primaryFace, ...fallbackFaces].flatMap(face => {
		const url = OFFICE_PDF_FONT_URLS[face.file]

		return url === undefined ? [] : [[face.file, { face, url }] as const]
	})
)
let drawing: Blob | null = null

// The drawing once (it is dropped as soon as the parser has it) and the bundled faces dxf-viewer asks for, decompressed.
async function resolve(path: string): Promise<Blob | null> {
	if (path === DXF_DRAWING_PATH) {
		const held = drawing

		drawing = null

		return held
	}

	const font = path.startsWith(DXF_FONT_PATH_PREFIX) ? fontUrls.get(path.slice(DXF_FONT_PATH_PREFIX.length)) : undefined

	if (font === undefined) return null

	const response = await fetch(font.url)

	if (!response.ok) return null

	// Decoded into a fresh ArrayBuffer (or the fetched one, already decoded).
	return new Blob([decodeFace(new Uint8Array(await response.arrayBuffer()), font.face) as Uint8Array<ArrayBuffer>])
}

// Nothing leaves the worker but the bundled faces.
installResourceSandbox({
	assets: [...fontUrls.values()].map(font => font.url),
	resolve,
	budget: DXF_MAX_BYTES + [...fontUrls.values()].reduce((sum, font) => sum + font.face.ttfBytes, 0)
})
installDxfGlobals()

let shell: MessagePort | null = null
let canvas: OffscreenCanvas | null = null
let viewer: DxfViewer | null = null
let size = { width: 1, height: 1 }
let pixelRatio = 1
let dark = false
let view: DxfView | null = null
let fitted = 1
const pointers = new Map<number, { x: number; y: number; buttons: number }>()
const rendererReady = Promise.withResolvers<WebGLRenderer | null>()

function send(message: WorkerToShell<DxfShellStatus>): void {
	shell?.postMessage(message)
}

function buildRenderer(next: OffscreenCanvas): WebGLRenderer | null {
	try {
		const built = new WebGLRenderer({ canvas: next, antialias: pixelRatio < 2, depth: false, powerPreference: "low-power" })

		next.addEventListener("webglcontextlost", () => {
			send({ type: "contextLost" })
		})
		// After three's own handler, which rebuilt its state with the default clear colour.
		next.addEventListener("webglcontextrestored", () => {
			viewer?.SetClearColor(dark ? BACKGROUNDS.dark : BACKGROUNDS.light)
			send({ type: "contextRestored" })
		})
		send({ type: "limits", maxTextureSize: built.capabilities.maxTextureSize })

		return built
	} catch {
		return null
	}
}

function showView(next: DxfView): void {
	if (viewer === null) return

	view = next
	viewer.SetView(new Vector3(next.x, next.y, 0), next.width)
	viewer.Render()
}

function fit(): void {
	const bounds = viewer?.GetBounds() ?? null
	const origin = viewer?.GetOrigin()

	if (viewer === null || bounds === null || origin === undefined) return

	viewer.FitView(bounds.minX - origin.x, bounds.maxX - origin.x, bounds.minY - origin.y, bounds.maxY - origin.y)

	const camera = viewer.GetCamera()

	view = { x: camera.position.x, y: camera.position.y, width: (camera.right - camera.left) / camera.zoom }
	fitted = view.width
	viewer.Render()
}

function zoomAbout(current: DxfView, factor: number, at: { x: number; y: number }): DxfView {
	return zoomDxfView(current, factor, at, size, fitted)
}

function input(events: readonly CanvasInput[]): void {
	if (view === null) return

	let next = view
	let fitAgain = false

	for (const event of events) {
		switch (event.type) {
			case "pointer": {
				const previous = pointers.get(event.id)

				if (event.phase === "down") {
					pointers.set(event.id, { x: event.x, y: event.y, buttons: event.buttons })
				} else if (event.phase === "move" && previous !== undefined) {
					const other = pointers.size >= 2 ? [...pointers.entries()].find(([id]) => id !== event.id)?.[1] : undefined

					if (other !== undefined) {
						// Pinch: the distance between the two pointers scales the view about their midpoint.
						const before = Math.hypot(previous.x - other.x, previous.y - other.y)
						const after = Math.hypot(event.x - other.x, event.y - other.y)

						if (before > 0) next = zoomAbout(next, after / before, { x: (event.x + other.x) / 2, y: (event.y + other.y) / 2 })
					} else {
						next = panDxfView(next, event.x - previous.x, event.y - previous.y, size)
					}

					pointers.set(event.id, { ...previous, x: event.x, y: event.y })
				} else if (event.phase === "up" || event.phase === "cancel") {
					pointers.delete(event.id)
				}

				break
			}
			case "wheel": {
				next = zoomAbout(next, Math.exp(-event.deltaY * IMAGE_WHEEL_SENSITIVITY), event)

				break
			}
			case "key": {
				if (event.phase !== "down") break

				const centre = { x: size.width / 2, y: size.height / 2 }

				// 0 fits the drawing again, as the toolbar's Fit (and the other canvas viewers' 0).
				if (event.key === "0") fitAgain = true
				if (event.key === "+" || event.key === "=") next = zoomAbout(next, KEY_ZOOM, centre)
				if (event.key === "-") next = zoomAbout(next, 1 / KEY_ZOOM, centre)
				if (event.key === "ArrowLeft") next = panDxfView(next, KEY_PAN, 0, size)
				if (event.key === "ArrowRight") next = panDxfView(next, -KEY_PAN, 0, size)
				if (event.key === "ArrowUp") next = panDxfView(next, 0, KEY_PAN, size)
				if (event.key === "ArrowDown") next = panDxfView(next, 0, -KEY_PAN, size)

				break
			}
		}
	}

	if (fitAgain) fit()
	else if (next !== view) showView(next)
}

function onShell({ data }: MessageEvent<ShellToWorker>): void {
	switch (data.type) {
		case "canvas": {
			// A fresh canvas after a display that did not come back: the viewer cannot move to it, so the page starts
			// a fresh worker over a fresh canvas.
			if (canvas !== null) {
				send({ type: "status", status: "restart" })

				break
			}

			canvas = data.canvas
			size = { width: data.width, height: data.height }
			pixelRatio = data.pixelRatio
			rendererReady.resolve(buildRenderer(dxfCanvas(canvas)))

			break
		}
		case "resize": {
			size = { width: data.width, height: data.height }
			pixelRatio = data.pixelRatio
			viewer?.SetSize(data.width, data.height)

			if (viewer !== null) {
				const camera = viewer.GetCamera()

				view = { x: camera.position.x, y: camera.position.y, width: (camera.right - camera.left) / camera.zoom }
			}

			break
		}
		case "input": {
			input(data.events)

			break
		}
		case "visibility": {
			break
		}
	}
}

// The characters past ASCII the drawing's text may draw, read through once in its encoding.
async function codePoints(source: Blob, encoding: string): Promise<ReadonlySet<number>> {
	const collected = new DxfCodePoints()
	const reader = source.stream().pipeThrough(new TextDecoderStream(encoding)).getReader()

	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		collected.add(chunk.value)
	}

	return collected.codePoints()
}

function layerColor(color: number): string {
	return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`
}

function outcome(status: DxfStatus, notices: { missingGlyphs: boolean; skipped: number } = { missingGlyphs: false, skipped: 0 }): DxfLoad {
	const layers = viewer === null || status !== "ready" ? [] : [...viewer.GetLayers(true)]

	return {
		status,
		layers: layers.slice(0, DXF_MAX_LISTED_LAYERS).map(layer => ({
			name: layer.name,
			label: layer.displayName,
			color: layerColor(layer.color),
			visible: layer.visible
		})),
		moreLayers: Math.max(0, layers.length - DXF_MAX_LISTED_LAYERS),
		...notices
	}
}

const api = {
	attach: (port: MessagePort): void => {
		shell?.close()
		shell = port
		port.onmessage = onShell
	},
	load: async (source: Blob, darkBackground: boolean): Promise<DxfLoad> => {
		const built = await rendererReady.promise

		if (built === null) return outcome("noWebgl")

		dark = darkBackground

		const encoding = dxfFileEncoding(new Uint8Array(await source.slice(0, DXF_HEADER_BYTES).arrayBuffer()))
		const faces: PdfFaceFile[] = dxfFontFaces(await codePoints(source, encoding), primaryFace, FALLBACK_FAMILIES)
		const loaded = createDxfViewer(built, {
			width: size.width,
			height: size.height,
			background: dark ? BACKGROUNDS.dark : BACKGROUNDS.light,
			pointSize: 2 * pixelRatio,
			encoding
		})
		const notices = watchDxfMessages(loaded)

		viewer = loaded
		drawing = source

		try {
			await loadDxf(
				loaded,
				faces.map(face => face.file)
			)
		} catch (error) {
			return outcome(dxfLoadFailure(error))
		} finally {
			drawing = null
		}

		if (loaded.GetBounds() === null) return outcome("empty")

		fit()

		return outcome("ready", { ...notices })
	},
	fit,
	showLayer: (name: string, visible: boolean): void => {
		viewer?.ShowLayer(name, visible)
	},
	background: (darkBackground: boolean): void => {
		dark = darkBackground
		viewer?.SetClearColor(dark ? BACKGROUNDS.dark : BACKGROUNDS.light)
	}
}

export type DxfWorkerApi = typeof api

Comlink.expose(api)
