import { DxfViewer, type LayerInfo } from "dxf-viewer"
import type { Color, WebGLRenderer } from "three"
import { dxfContainer } from "@/features/preview/lib/dxfStubs"

// How the CAD worker has dxf-viewer build and load a drawing, and how it reads what the build reports. Worker-only:
// dxf-viewer and three stay out of the page.

// The scene's work budget (patched into dxf-viewer, see pnpm-workspace.yaml): entity visits, generated vertices and
// indices, spline sampling, hatch lines and dash steps, each block instance's vertices, render batches and the fonts
// loaded. Measured at about 0.3 µs, 40-90 bytes of heap and 11 bytes of scene buffer a unit at worst: 2^23 holds a
// 32 MiB drawing of plain geometry at 40 % and bounds the build at about 0.7 GB over the parse.
export const DXF_MAX_WORK = 8_388_608
// One entity's work, checked before it generates its geometry.
export const DXF_MAX_ENTITY_WORK = 1_048_576
// Bytes of TrueType counted as one unit of work: opentype.js and dxf-viewer hold a parsed face at about 7 times its
// size (Noto Sans SC: 10.6 MB, 77 MB of heap), about 64 bytes a unit.
export const DXF_FONT_BYTES_PER_WORK = 8

export interface DxfNotices {
	// Some text has characters no offered font draws.
	missingGlyphs: boolean
	// Malformed entities left out.
	skipped: number
}

// dxf-viewer reports what it could not draw as English messages only (DxfViewer.Load, 1.0.51).
export function watchDxfMessages(viewer: DxfViewer): DxfNotices {
	const notices: DxfNotices = { missingGlyphs: false, skipped: 0 }

	viewer.Subscribe("message", (event: CustomEvent<{ message: string }>) => {
		const skipped = /^(\d+) malformed entities were skipped$/.exec(event.detail.message)

		if (skipped !== null) notices.skipped = Number(skipped[1])
		else if (event.detail.message.startsWith("Some characters cannot be properly displayed")) notices.missingGlyphs = true
	})

	return notices
}

// A failed Load: over the scene's budget, or anything else (a parse error, a fetch that failed).
export function dxfLoadFailure(error: unknown): "tooComplex" | "malformed" {
	return error instanceof Error && (error.name === "DxfSceneTooComplex" || error.name === DXF_MEMORY_EXCEEDED)
		? "tooComplex"
		: "malformed"
}

// The worker's memory a build may reach before it is ended (defence in depth: the scene's budget holds a 16 MiB
// drawing at about 1 GB at worst).
export const DXF_MAX_WORKER_BYTES = 1.5 * 1024 * 1024 * 1024
// The estimate where the engine cannot measure: the parsed tree held through the build, a unit of work at its
// measured worst, and the fonts at their parsed size.
export const DXF_TREE_BYTES_PER_BYTE = 16
export const DXF_BYTES_PER_WORK = 96
export const DXF_FONT_HEAP_PER_BYTE = 8

const DXF_MEMORY_EXCEEDED = "DxfMemoryExceeded"

export interface DxfMemorySource {
	// The drawing's size.
	readonly sourceBytes: number
	// Bytes of the fonts loaded so far.
	readonly fontBytes: () => number
	// The engine's measurement of the worker (performance.measureUserAgentSpecificMemory), where it has one.
	readonly measure: (() => Promise<{ bytes: number }>) | null
}

// The scene's checkpoint: past DXF_MAX_WORKER_BYTES, by the latest measurement or else the estimate, the build ends. A
// measurement is asked for when none is pending, and the build lets other tasks run so it can arrive.
export function dxfMemoryGuard(source: DxfMemorySource): (work: number) => Promise<void> {
	let measured: number | null = null
	let pending = false

	return async work => {
		const estimate =
			source.sourceBytes * DXF_TREE_BYTES_PER_BYTE + work * DXF_BYTES_PER_WORK + source.fontBytes() * DXF_FONT_HEAP_PER_BYTE

		if ((measured ?? estimate) > DXF_MAX_WORKER_BYTES) {
			throw Object.assign(new Error("The build would take more memory than the viewer may"), { name: DXF_MEMORY_EXCEEDED })
		}

		if (source.measure === null) return

		if (!pending) {
			pending = true
			source.measure().then(
				result => {
					measured = result.bytes
					pending = false
				},
				() => {
					pending = false
				}
			)
		}

		// One task's turn, without a timer's clamp.
		await new Promise<void>(resolve => {
			const channel = new MessageChannel()

			channel.port1.onmessage = () => {
				channel.port1.close()
				resolve()
			}
			channel.port2.postMessage(null)
		})
	}
}

// Where the drawing and the fonts are asked for: the worker's resource sandbox answers `filen-ref:` URLs.
export const DXF_DRAWING_PATH = "drawing.dxf"
export const DXF_FONT_PATH_PREFIX = "fonts/"

export interface DxfViewerSetup {
	readonly width: number
	readonly height: number
	readonly background: Color
	// Dot marks' size in backing pixels.
	readonly pointSize: number
	readonly encoding: string
	// Work the fonts loaded so far count for.
	readonly fontWork: () => number
	// Called every few thousand entities with the work done; throws to end the build.
	readonly checkpoint: (work: number) => Promise<void>
}

// A viewer on `renderer` (its canvas given dxfCanvas's expandos first). Nothing is retained of the parse but the scene.
export function createDxfViewer(renderer: WebGLRenderer, setup: DxfViewerSetup): DxfViewer {
	return new DxfViewer(dxfContainer(setup.width, setup.height) as unknown as HTMLElement, {
		renderer,
		autoResize: false,
		canvasWidth: setup.width,
		canvasHeight: setup.height,
		clearColor: setup.background,
		colorCorrection: true,
		pointSize: setup.pointSize,
		fileEncoding: setup.encoding,
		retainParsedDxf: false,
		sceneOptions: {
			maxWork: DXF_MAX_WORK,
			maxEntityWork: DXF_MAX_ENTITY_WORK,
			fontWork: setup.fontWork,
			checkpoint: setup.checkpoint,
			releaseParsedDxf: true
		}
	})
}

// Parsed and built in this thread (no worker of dxf-viewer's own); `fonts` are face files of the office fonts.
export async function loadDxf(viewer: DxfViewer, fonts: readonly string[]): Promise<void> {
	await viewer.Load({
		url: `filen-ref:///${DXF_DRAWING_PATH}`,
		fonts: fonts.map(file => `filen-ref:///${DXF_FONT_PATH_PREFIX}${file}`),
		workerFactory: null
	})
}

// Restored contexts a worker draws into; past it the display is reported failed (a drawing whose draw resets the GPU
// would reset it again and again, and the browser then blocks WebGL for the whole app).
export const DXF_MAX_RESTORES = 2
// Layers listed in the panel at most; the rest are counted.
export const DXF_MAX_LISTED_LAYERS = 1000
// Characters of a layer's name sent to the page at most.
export const DXF_MAX_LAYER_LABEL = 256

export interface DxfLayer {
	// What ShowLayer takes.
	readonly name: string
	readonly label: string
	// CSS colour, as drawn against the background at load.
	readonly color: string
	readonly visible: boolean
}

// The layers the page lists: the first DXF_MAX_LISTED_LAYERS, their names cut to DXF_MAX_LAYER_LABEL, and how many more.
export function dxfLayerList(layers: Iterable<LayerInfo>): { layers: DxfLayer[]; more: number } {
	const listed: DxfLayer[] = []
	let more = 0

	for (const layer of layers) {
		if (listed.length === DXF_MAX_LISTED_LAYERS) {
			more++

			continue
		}

		listed.push({
			name: layer.name,
			label: layer.displayName.slice(0, DXF_MAX_LAYER_LABEL),
			color: `#${(layer.color & 0xffffff).toString(16).padStart(6, "0")}`,
			visible: layer.visible
		})
	}

	return { layers: listed, more }
}
