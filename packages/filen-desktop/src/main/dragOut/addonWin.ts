import { nativeFilePath, type AddonPathContext } from "../native/addonPath.ts"

// filen-drag.node (native/dragOut/win): Explorer extracts dragged drive items as virtual files from a data object that
// lives on an addon-owned COM thread, so it keeps answering after begin returned and while main JS runs.

// One planned entry (planEntries' output): a "\\"-separated relative path of at most 259 UTF-16 units.
export interface DragOutEntryWin {
	path: string
	directory: boolean
	size: bigint
	// Explorer stamps it as the file's write time; null leaves the time to Explorer.
	mtimeMs: number | null
}

export interface DragOutBeginWin {
	// BrowserWindow.getNativeWindowHandle(): 8 bytes, non-zero.
	hwnd: Buffer
	entries: DragOutEntryWin[]
	// nativeImage.toBitmap(): premultiplied BGRA, width × height × 4 bytes.
	image: { bgra: Buffer; width: number; height: number }
	// Explorer wants entry `index`; answer with complete(ticket, path) or fail(ticket). Queued while begin blocks.
	onContents(ticket: number, index: number): void
	// Every stream of the ticket was released (Explorer finished, failed or cancelled it).
	onRelease(ticket: number): void
	// Explorer's extraction ended (EndOperation): every stream still waiting fails.
	onOperationEnd(result: "ok" | "aborted" | "failed"): void
}

export interface DragOutAddonWin {
	// Main thread; blocks in DoDragDrop until the drop or cancel, so main JS, IPC and the callbacks above stall
	// meanwhile. "failed": the target took the drop without an async extraction (a sync-only target, refused) or
	// DoDragDrop failed. Throws (code "InvalidArg") on a bad handle, entry or image, or while another drag runs.
	begin(options: DragOutBeginWin): "dropped" | "cancelled" | "failed"
	// The entry's temp file is whole; Explorer reads it and the addon deletes it once every stream is released.
	complete(ticket: number, path: string): void
	fail(ticket: number): void
	// Quit: every waiting read fails and no new stream is handed out.
	abort(): void
}

export const DRAG_ADDON_WIN_FILE = "filen-drag.node"

export interface DragOutAddonWinContext extends Omit<AddonPathContext, "env"> {
	// Throws when the file is not a loadable addon for this process.
	load(file: string): unknown
}

// The shipped or staged addon on Windows; null elsewhere or when it is missing.
export function dragOutAddonWinPath(ctx: Omit<AddonPathContext, "env">): string | null {
	return ctx.platform === "win32" ? nativeFilePath(ctx, DRAG_ADDON_WIN_FILE) : null
}

// Loads the addon on first use only (the first drag out); null off Windows or when the addon is missing.
export function createDragOutAddonWin(ctx: DragOutAddonWinContext): () => DragOutAddonWin | null {
	let addon: DragOutAddonWin | null | undefined

	return () => {
		if (addon === undefined) {
			const file = dragOutAddonWinPath(ctx)

			addon = file === null ? null : (ctx.load(file) as DragOutAddonWin)
		}

		return addon
	}
}
