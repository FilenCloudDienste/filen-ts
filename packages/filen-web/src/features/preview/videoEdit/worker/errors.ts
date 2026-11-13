import type { ExportRefusal } from "@/features/preview/videoEdit/worker/exportApi"

// An export that stopped because of its input (see ExportRefusal), not a fault.
export class ExportRefusedError extends Error {
	public readonly refusal: ExportRefusal

	public constructor(refusal: ExportRefusal, detail: string) {
		super(detail)
		this.name = "ExportRefusedError"
		this.refusal = refusal
	}
}

export class ExportCancelledError extends Error {
	public constructor() {
		super("export cancelled")
		this.name = "ExportCancelledError"
	}
}

export function throwIfCancelled(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new ExportCancelledError()
	}
}
