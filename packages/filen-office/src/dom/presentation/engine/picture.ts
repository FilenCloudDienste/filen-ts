import { pictureFillOf } from "../../../core/presentation/edit/apply/picture"
import { findShape } from "../../../core/presentation/edit/changes"
import { PresentationError, type ShapeRef } from "../../../core/presentation/model"
import { isRefused } from "../../../core/presentation/refusal"
import type { CallContext } from "../engine"
import type { PictureFormat } from "../protocol"
import { withClipReading } from "./edit"

// The picture capability: a picture's crop and adjustments as an edit of it starts from (its typed fill, else its
// source's), read once when the Picture tab opens a dialog. Queued with the commands, prepared as a picture op is.

export function pictureFormat(context: CallContext, target: ShapeRef): Promise<PictureFormat> {
	const deck = context.session.deck

	return withClipReading(context, { family: "picture", kind: "adjust", target, adjust: undefined }, reading => {
		const node = deck.nodes.get(target.slide)
		const shape = node === undefined ? undefined : findShape(node.shapes, target.id)?.shape

		if (node === undefined || shape === undefined) throw new PresentationError("notFound", `shape ${String(target.id)}`)
		if (shape.kind !== "pic" || shape.media !== undefined)
			throw new PresentationError("unsupported", `shape ${String(target.id)} is not a picture`)

		const fill = pictureFillOf(shape) ?? reading.pictureFill?.(node, shape)

		if (isRefused(fill)) throw new PresentationError(fill.reason, fill.detail ?? "pictureFormat")

		return {
			...(fill?.crop === undefined ? {} : { crop: fill.crop }),
			...(fill?.adjust === undefined ? {} : { adjust: fill.adjust })
		}
	})
}

export const pictureCapability = { pictureFormat }
