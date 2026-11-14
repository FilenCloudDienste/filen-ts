// The transfer list of a postMessage from an office transport, whose types know no DOM (its items are `unknown`):
// each item checked to be one of the transferable objects the editors send (buffers, ports, bitmaps, canvases,
// streams). Anything else is a programming error, thrown here rather than as a DataCloneError from postMessage.

function isTransferable(item: unknown): item is Transferable {
	return (
		item instanceof ArrayBuffer ||
		(typeof MessagePort !== "undefined" && item instanceof MessagePort) ||
		(typeof ImageBitmap !== "undefined" && item instanceof ImageBitmap) ||
		(typeof OffscreenCanvas !== "undefined" && item instanceof OffscreenCanvas) ||
		(typeof ReadableStream !== "undefined" && item instanceof ReadableStream) ||
		(typeof WritableStream !== "undefined" && item instanceof WritableStream) ||
		(typeof TransformStream !== "undefined" && item instanceof TransformStream)
	)
}

export function transferList(items: readonly unknown[]): Transferable[] {
	const list: Transferable[] = []

	for (const item of items) {
		if (!isTransferable(item)) throw new TypeError("not a transferable object")

		list.push(item)
	}

	return list
}
