import type {
	EditSession,
	ImageEditRecipe,
	ImageEditSource,
	ImageExportSource,
	SaveTarget,
	SourceInfo
} from "@/features/preview/imageEdit/types"
import { composeOrientation, isGeometryOnly, type Crop, type Size } from "@/features/preview/imageEdit/lib/recipe"

// The editor's dealings with its render session that are not drawing: loading the source once, and the export a save
// reads.

// One load per session: the source is transferred to the worker, so an effect run again (Strict Mode, a remount with
// the same session) reuses the first load instead of handing over a detached buffer.
const loads = new WeakMap<EditSession, Promise<Size>>()

export function loadOnce(session: EditSession, source: ImageEditSource, info: SourceInfo): Promise<Size> {
	const known = loads.get(session)

	if (known !== undefined) {
		return known
	}

	const loading = session.load(source, info)

	loads.set(session, loading)

	return loading
}

// The original's own quality, kept within a range where re-encoding neither bloats nor visibly degrades it.
export function exportJpegQuality(info: SourceInfo): number {
	return Math.min(92, Math.max(75, info.jpegQuality ?? 92)) / 100
}

// What a save to `target` writes: for a JPEG saved in place that was only turned or flipped, the Orientation the
// overlay rewrites losslessly (no pixels re-encoded); otherwise the full-resolution export.
export function exportForTarget(
	session: EditSession,
	info: SourceInfo,
	recipe: ImageEditRecipe,
	target: SaveTarget
): ReturnType<ImageExportSource> {
	const geometry = recipe.geometry

	if (isGeometryOnly(recipe) && info.mime === "image/jpeg" && target.kind === "inPlace" && target.mime === "image/jpeg") {
		return Promise.resolve({
			blob: null,
			geometryOnly: { orientation: composeOrientation(info.orientation, geometry.quarterTurns, geometry.flipH, geometry.flipV) }
		})
	}

	return session
		.export(
			recipe,
			{ mime: target.mime, quality: target.mime === "image/jpeg" ? exportJpegQuality(info) : 1 },
			{ exif: info.exif, icc: info.icc, hasAlpha: info.hasAlpha, webpLossless: info.webpLossless }
		)
		.then(blob => ({ blob, geometryOnly: null }))
}

const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 }

// What the canvas shows for `recipe`: the whole frame while cropping (the crop frame is drawn over it), and without
// the text item being edited (its field stands in for it).
export function displayRecipe(recipe: ImageEditRecipe, cropping: boolean, editingText: string | null): ImageEditRecipe {
	return {
		...recipe,
		geometry: cropping ? { ...recipe.geometry, crop: FULL_CROP } : recipe.geometry,
		markup: editingText === null ? recipe.markup : recipe.markup.filter(item => item.id !== editingText)
	}
}
