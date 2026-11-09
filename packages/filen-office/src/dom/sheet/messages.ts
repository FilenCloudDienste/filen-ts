import type {
	SheetEncryptionRefusal,
	SheetEvent,
	SheetLockedFile,
	SheetOpenFailure,
	SheetOpenOptions,
	SheetWorkbookInfo
} from "../../core/sheet/protocol"

// The messages between a page and a sheet worker. `s` names the open (one file, then its session); `id` names a
// call on it. Answers and events for one open come in the order the worker made them.

export type SheetWorkerMethod = "tiles" | "layout" | "command" | "undo" | "redo" | "query" | "intent" | "save" | "export" | "markSaved"

export type SheetWorkerNotice = "release" | "viewOnly" | "configure" | "close"

export type SheetWorkerOpenOptions = Omit<SheetOpenOptions, "signal" | "slicing">

export type ToSheetWorker =
	| { readonly t: "open"; readonly s: number; readonly bytes: Uint8Array; readonly options: SheetWorkerOpenOptions }
	| { readonly t: "abortOpen"; readonly s: number }
	| { readonly t: "unlock"; readonly s: number; readonly id: number; readonly password: string }
	| { readonly t: "abortUnlock"; readonly s: number; readonly id: number }
	| { readonly t: "dispose"; readonly s: number }
	| { readonly t: "call"; readonly s: number; readonly id: number; readonly method: SheetWorkerMethod; readonly args: readonly unknown[] }
	| { readonly t: "abort"; readonly s: number; readonly id: number }
	| { readonly t: "notice"; readonly s: number; readonly notice: SheetWorkerNotice; readonly args: readonly unknown[] }
	// A job the worker was given (serveSheetWorker's `jobs`), run beside the session; "abort" with its id cancels it.
	| { readonly t: "job"; readonly s: number; readonly id: number; readonly name: string; readonly args: unknown }

export type SheetWorkerOpened =
	| { readonly kind: "opened"; readonly info: SheetWorkbookInfo }
	| { readonly kind: "needsPassword"; readonly scheme: SheetLockedFile["scheme"]; readonly spinCount: number }
	| { readonly kind: "refused"; readonly reason: SheetEncryptionRefusal }
	| { readonly kind: "failed"; readonly reason: SheetOpenFailure; readonly message: string }
	| { readonly kind: "aborted" }

export type SheetWorkerUnlocked =
	| { readonly ok: true; readonly info: SheetWorkbookInfo }
	| { readonly ok: false; readonly reason: "wrongPassword" | "aborted" | SheetEncryptionRefusal }

export type FromSheetWorker =
	| { readonly t: "opened"; readonly s: number; readonly result: SheetWorkerOpened }
	| { readonly t: "unlocked"; readonly s: number; readonly id: number; readonly result: SheetWorkerUnlocked }
	| { readonly t: "event"; readonly s: number; readonly event: SheetEvent }
	| { readonly t: "result"; readonly s: number; readonly id: number; readonly value?: unknown; readonly error?: string }
	// How far a job is, as it reports it.
	| { readonly t: "progress"; readonly s: number; readonly id: number; readonly value: unknown }

// The job checking a protected workbook's password against the file as stored (jobs.ts), and its verdicts.
export const SHEET_PASSWORD_JOB = "protection.check"

export type SheetPasswordVerdict = "accepted" | "default" | "wrong" | "aborted" | "failed"

// The buffers of every typed array in a message (each owns its whole buffer: the protocol's rule), to transfer.
export function transferables(value: unknown): ArrayBuffer[] {
	const into = new Set<ArrayBuffer>()

	collect(value, into, 0)

	return [...into]
}

function collect(value: unknown, into: Set<ArrayBuffer>, depth: number): void {
	if (depth > 8 || typeof value !== "object" || value === null) return

	if (ArrayBuffer.isView(value)) {
		const buffer = value.buffer

		if (buffer instanceof ArrayBuffer && buffer.byteLength === value.byteLength) into.add(buffer)

		return
	}

	if (Array.isArray(value)) {
		for (const item of value) if (typeof item === "object" && item !== null) collect(item, into, depth + 1)

		return
	}

	if (value instanceof Set || value instanceof Map) return

	for (const item of Object.values(value)) if (typeof item === "object" && item !== null) collect(item, into, depth + 1)
}
