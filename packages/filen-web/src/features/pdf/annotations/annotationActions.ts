import type { PdfAnnotationRef } from "@filen/office/core/pdfedit/annotations"
import type { PdfCommandResult } from "@filen/office/core/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { centredRect, stampSize } from "@filen/office/react/pdfedit/tools"
import { driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PdfAnnotationStore, PdfComposing, PdfStampPlacement } from "@/features/pdf/annotations/annotationStore"
import { prepareStampImage } from "@/features/pdf/annotations/stampImage"
import type { PdfToolContext } from "@/features/pdf/tools/registry"
import { readDriveFileBytes } from "@/features/preview/lib/docxImages"

// The annotation host's changes as plain functions (each one editor command through the tool context).

// Runs `change`, answering whether it applied: a refusal is shown by the host (onChangeFailed) and answers false.
export function applied(context: PdfToolContext, change: (session: PdfEditSessionModel) => Promise<PdfCommandResult>): Promise<boolean> {
	return new Promise(resolve => {
		context.edit(session =>
			change(session).then(
				result => {
					resolve(true)

					return result
				},
				(error: unknown) => {
					resolve(false)

					throw error
				}
			)
		)
	})
}

// A comment written in the Comments panel: a new sticky note, or the first note of an annotation. The new thread's
// id, null when refused.
export async function postComment(
	context: PdfToolContext,
	store: PdfAnnotationStore,
	composing: PdfComposing,
	text: string,
	author: string
): Promise<string | null> {
	const target: { ref: PdfAnnotationRef | null } = { ref: composing.kind === "comment" ? composing.ref : null }
	const ok = await applied(context, async session => {
		const result =
			composing.kind === "note"
				? await session.dispatch("annotations.note", { page: composing.page, at: composing.at, text, author })
				: await session.dispatch("annotations.text", { ...composing.ref, text })

		target.ref = result.created ?? target.ref

		return result
	})

	store.compose(null)

	if (!ok || target.ref === null) return null

	store.selectRef(target.ref)

	return String(target.ref.id)
}

// The stamp picture taken and placed where it was wanted, as one command; the tool goes back to selection.
export async function placePicture(
	context: PdfToolContext,
	store: PdfAnnotationStore,
	wanted: PdfStampPlacement,
	bytes: Uint8Array,
	name: string
): Promise<void> {
	const image = await prepareStampImage(bytes, name)
	const size = stampSize(image.width, image.height)
	const rect = centredRect(wanted.at, size.width, size.height, wanted.box)

	store.wantImage(null)

	const author = await store.author()

	if (author === null) return

	context.edit(async session => {
		const result = await session.dispatch("annotations.image", { page: wanted.page, author, rect, image: image.bytes })

		if (result.created !== undefined) store.selectRef(result.created)

		return result
	})
	context.finish()
}

// A picture picked in Filen, read through the SDK worker (cancelled with `signal`) and placed.
export async function placeDrivePicture(
	context: PdfToolContext,
	store: PdfAnnotationStore,
	wanted: PdfStampPlacement,
	item: DriveItem,
	signal: AbortSignal
): Promise<void> {
	const bytes = await readDriveFileBytes(item, signal)

	await placePicture(context, store, wanted, bytes, driveItemName(item))
}
