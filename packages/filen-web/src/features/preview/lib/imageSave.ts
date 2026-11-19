import type { DriveItem } from "@/features/drive/lib/item"
import { editedSaveTimes, runPreviewSave, type ImageSaveEdits } from "@/features/drive/lib/previewSave.logic"
import { copyTargetOf } from "@/features/preview/components/previewOverlay.logic"
import type { ImageEditState } from "@/features/preview/imageEdit/editSession"
import { ORIENTATION_REWRITE_UNAVAILABLE } from "@/features/preview/imageEdit/orientationRewrite"
import type { ImageExportSource, SaveTarget } from "@/features/preview/imageEdit/types"
import { imageSaveDeps, writeEditedCopy } from "@/features/preview/lib/editedCopy"
import { loadPreviewBytes } from "@/features/preview/lib/previewCache"
import type { ActionOutcome } from "@/lib/actions/outcome"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

// The image editor's saves: its export written as a new version of the file or as a copy beside it (editedCopy.ts),
// and read for the remote-change dialog's "save mine as new".

type ImageExport = Awaited<ReturnType<ImageExportSource>>

async function exportImage(source: ImageExportSource | null, target: SaveTarget): Promise<ImageExport | null> {
	if (source === null) {
		return null
	}

	return await source(target).catch((e: unknown) => {
		log.error("preview", "exporting the edited image failed", e)

		return null
	})
}

function rewriteUnavailable(dto: ErrorDTO): boolean {
	return dto.species === "plain" && dto.message.startsWith(ORIENTATION_REWRITE_UNAVAILABLE)
}

// A new version of the file in its own format: the export, or for a JPEG only turned or flipped its Orientation
// rewritten in the file itself, re-encoded after all when that cannot be done. `blob`: what was uploaded, if a Blob.
// Null when there was nothing to upload (the export failed).
export async function writeImageInPlace(
	item: DriveItem,
	target: Extract<SaveTarget, { kind: "inPlace" }>,
	source: ImageExportSource | null
): Promise<{ outcome: ActionOutcome<DriveItem>; blob: Blob | null } | null> {
	const exported = await exportImage(source, target)

	if (exported === null) {
		return null
	}

	const times = editedSaveTimes(item, Date.now())
	const deps = imageSaveDeps()

	if (exported.geometryOnly !== null) {
		const rewritten = await runPreviewSave(deps, {
			item,
			content: { orientation: exported.geometryOnly.orientation },
			times,
			mime: target.mime
		})

		if (rewritten.status === "success" || !rewriteUnavailable(rewritten.dto)) {
			return { outcome: rewritten, blob: null }
		}

		// The same JPEG encode a copy gets, uploaded in place.
		const reencoded = (await exportImage(source, { kind: "copy", mime: "image/jpeg", extension: "jpg" }))?.blob ?? null

		if (reencoded === null) {
			return null
		}

		return { outcome: await runPreviewSave(deps, { item, content: { blob: reencoded }, times, mime: target.mime }), blob: reencoded }
	}

	const blob = exported.blob

	if (blob === null) {
		return null
	}

	return { outcome: await runPreviewSave(deps, { item, content: { blob }, times, mime: target.mime }), blob }
}

// A copy beside the file, named "photo (edited).jpg" (or the first such name free) from one read of the directory's
// names, and typed by the SDK from that name.
export async function writeImageCopy(
	item: DriveItem,
	target: Extract<SaveTarget, { kind: "copy" }>,
	source: ImageExportSource | null,
	suffix: (number: number) => string
): Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null> {
	const blob = (await exportImage(source, target))?.blob ?? null

	return blob === null ? null : await writeEditedCopy(item, { blob }, target.extension, suffix)
}

// The edited image for the remote-change dialog's "save mine as new": as the header's Save would write it, or
// re-encoded where that is the lossless rewrite of the file itself (a new file has no file to rewrite).
export async function readImageEdits(
	state: ImageEditState,
	source: ImageExportSource | null,
	inPlace: boolean
): Promise<ImageSaveEdits | null> {
	const target = inPlace && state.targets.primary.kind === "inPlace" ? state.targets.primary : copyTargetOf(state)
	const exported = await exportImage(source, target)

	if (exported === null) {
		return null
	}

	if (exported.blob !== null) {
		return {
			kind: "blob",
			blob: exported.blob,
			extension: target.kind === "copy" && target.mime !== state.info.mime ? target.extension : null
		}
	}

	const copy = copyTargetOf(state)
	const encoded = (await exportImage(source, copy))?.blob ?? null

	if (encoded === null) {
		return null
	}

	return { kind: "blob", blob: encoded, extension: copy.mime !== state.info.mime ? copy.extension : null }
}

// Keeps a saved image's bytes for the preview of the version it made, read from the Blob that was uploaded.
export async function seedSavedImage(cacheScope: string | null, uuid: string, blob: Blob): Promise<void> {
	await loadPreviewBytes(cacheScope, uuid, blob.size, async () => new Uint8Array(await blob.arrayBuffer())).catch((e: unknown) => {
		log.warn("preview", "keeping the saved image's bytes failed", e)
	})
}
