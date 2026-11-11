import { macAddonPath, type AddonPathContext } from "../native/addonPath.ts"

// The drag-out half of filen-mac.node (native/mac/DragOut.swift): an OS drag of file promises, which Finder fulfils by
// asking for each item at a URL it supplies. Every call runs on the JS thread of the main process (AppKit's main
// thread); the callbacks arrive there too, also while AppKit tracks the drag.
export interface DragOutAddonMac {
	// Starts the drag from the window's current mouse location and returns at once. Throws a DragOutAddonError.
	begin(options: {
		// BrowserWindow.getNativeWindowHandle(): the NSView pointer, 8 bytes, non-zero.
		view: Buffer
		// name: one path component, already localName(…, "darwin"); contentType: a UTType identifier, ignored for
		// directories ("public.folder"), "public.data" when null or not a data type.
		items: { name: string; directory: boolean; contentType: string | null }[]
		// The drag image in points.
		image: { png: Buffer; width: number; height: number }
		// Finder wants item `index` at `path`; answer with fulfil(ticket, …).
		onWrite(ticket: number, index: number, path: string): void
		// Finder's cancel on the ticket's progress; fulfil still follows.
		onCancel(ticket: number): void
		onEnded(operation: "copy" | "none"): void
	}): void
	// Re-publishes the ticket's progress on the file the bytes are written to, which Finder shows while it grows.
	progressAt(ticket: number, path: string): void
	progress(ticket: number, completed: number, total: number): void
	// Completes Finder's write once; "cancelled" reads as the user's cancel. Later calls and unknown tickets are ignored.
	fulfil(ticket: number, error: string | null): void
}

// invalidArgument: a malformed option. buttonReleased: the primary button is up, so no drag can start (the page's drag
// ended meanwhile). busy: a drag of this addon still runs. internalFailure: AppKit or Node-API refused.
export type DragOutAddonErrorCode = "invalidArgument" | "buttonReleased" | "busy" | "internalFailure"

export interface DragOutAddonError extends Error {
	code: DragOutAddonErrorCode
}

export interface DragOutAddonContext extends Omit<AddonPathContext, "env"> {
	// Throws when the file is not a loadable addon for this process.
	load(file: string): unknown
	warn(message: string): void
}

// The addon on macOS, null elsewhere, when it is missing or does not load: drags then answer "unavailable".
export function createDragOutAddon(ctx: DragOutAddonContext): DragOutAddonMac | null {
	const file = macAddonPath(ctx)

	if (file === null) {
		return null
	}

	try {
		return ctx.load(file) as DragOutAddonMac
	} catch (error) {
		ctx.warn(`dragOut: ${file} did not load: ${error instanceof Error ? error.message : String(error)}`)

		return null
	}
}
