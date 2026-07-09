// Pure state transition for the delete-account chain: two sequential destructive ConfirmDialogs,
// then — only when the account has two-factor authentication enabled — a code prompt before the
// actual request. Mirrors skipMasterKeysChain.logic.ts's shape (confirming advances exactly one
// step; cancelling from ANY step aborts the whole chain, never falls back a step), extended with
// the 2FA branch at the end instead of a fixed final stage.
export type DeleteAccountConfirmStage = "stage1" | "stage2"
export type DeleteAccountStage = DeleteAccountConfirmStage | "code"

export type DeleteAccountChainOutcome =
	// Confirmed short of the terminal step — the caller opens `stage` next.
	| { status: "advance"; stage: DeleteAccountStage }
	// Stage 2 just confirmed and the account has NO two-factor authentication enabled — there is no
	// code to collect; the caller runs `deleteAccount()` with no code argument.
	| { status: "submit" }
	// Cancelled — via ANY dismissal route, from either confirm stage. Never falls back a stage.
	| { status: "aborted" }

export function advanceDeleteAccountChain(
	current: DeleteAccountConfirmStage,
	confirmed: boolean,
	twoFactorEnabled: boolean
): DeleteAccountChainOutcome {
	if (!confirmed) {
		return { status: "aborted" }
	}
	if (current === "stage1") {
		return { status: "advance", stage: "stage2" }
	}
	return twoFactorEnabled ? { status: "advance", stage: "code" } : { status: "submit" }
}
