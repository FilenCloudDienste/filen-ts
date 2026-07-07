// Pure state transition for the skip-master-keys-file ceremony gating the reset submit: three
// sequential ConfirmDialogs (stage1-3) then one TypedConfirmDialog (stage4), shown only when the user
// submits without an imported master-keys file. Extracted so "confirming advances exactly one stage"
// and "cancelling from ANY stage aborts the whole submit" are unit-tested without mounting a dialog.
export type SkipMasterKeysStage = "stage1" | "stage2" | "stage3" | "stage4"

const STAGE_ORDER: readonly SkipMasterKeysStage[] = ["stage1", "stage2", "stage3", "stage4"]

export type SkipMasterKeysChainOutcome =
	// Confirmed short of the last stage — the caller opens `stage` next.
	| { status: "advance"; stage: SkipMasterKeysStage }
	// The typed-confirm stage (the last) just confirmed — the whole chain passed; the caller runs the
	// actual reset submit, with no master-keys file.
	| { status: "complete" }
	// Cancelled — via ANY dismissal route (Escape, the cancel button, or an outside-press where the
	// dialog allows it), from ANY of the four stages. Never falls back a stage; always ends the chain.
	| { status: "aborted" }

export function advanceSkipMasterKeysChain(current: SkipMasterKeysStage, confirmed: boolean): SkipMasterKeysChainOutcome {
	if (!confirmed) {
		return { status: "aborted" }
	}
	const next = STAGE_ORDER[STAGE_ORDER.indexOf(current) + 1]
	return next ? { status: "advance", stage: next } : { status: "complete" }
}
