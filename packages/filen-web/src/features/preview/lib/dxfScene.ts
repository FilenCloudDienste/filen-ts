import { DxfViewer, type DxfSceneOptions } from "dxf-viewer"
import type { Color, WebGLRenderer } from "three"
import { dxfContainer } from "@/features/preview/lib/dxfStubs"

// How the CAD worker has dxf-viewer build and load a drawing, and how it reads what the build reports. Worker-only:
// dxf-viewer and three stay out of the page.

// The scene's work budget (patched into dxf-viewer, see pnpm-workspace.yaml): entity visits, generated vertices and
// indices, arc segments, hatch lines and dash steps. Mostly vertices, 8 bytes each in the scene's buffers.
export const DXF_MAX_WORK = 32 * 1024 * 1024
// One entity's generated vertices and indices, held as objects until the entity is written.
export const DXF_MAX_ENTITY_WORK = 1024 * 1024

export const DXF_SCENE_OPTIONS: DxfSceneOptions = { maxWork: DXF_MAX_WORK, maxEntityWork: DXF_MAX_ENTITY_WORK }

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
	return error instanceof Error && error.name === "DxfSceneTooComplex" ? "tooComplex" : "malformed"
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
		sceneOptions: DXF_SCENE_OPTIONS
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
