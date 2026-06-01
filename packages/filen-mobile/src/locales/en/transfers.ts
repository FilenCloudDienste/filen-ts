// Transfers feature vocabulary (src/routes/transfers/index.tsx and
// src/components/floatingBar/transfersSlot.tsx). Shared keys (cancel, close, …) live in
// common.ts and must not be redefined here.
export const transfers = {
	/** Transfers screen — header title (the list of active uploads/downloads) */
	transfers: "Transfers",
	/** Empty-state message shown when there are no active uploads or downloads */
	no_transfers: "No transfers",
	/** Floating-bar / transfer-menu action: pause a single in-progress transfer */
	pause: "Pause",
	/** Floating-bar / transfer-menu action: resume a single paused transfer */
	resume: "Resume",
	/** Header menu action: pause every active transfer at once */
	pause_all: "Pause all",
	/** Header menu action: resume every paused transfer at once */
	resume_all: "Resume all",
	/** Header menu action / confirm button: cancel every active transfer at once */
	cancel_all: "Cancel all",
	/** Confirmation dialog title shown before cancelling a single transfer */
	cancel_transfer: "Cancel transfer",
	/** Confirmation dialog message shown before cancelling a single transfer */
	confirm_cancel_transfer: "Are you sure you want to cancel this transfer?",
	/** Confirmation dialog title shown before cancelling every active transfer */
	cancel_all_transfers: "Cancel all transfers",
	/** Confirmation dialog message shown before cancelling every active transfer */
	confirm_cancel_all_transfers: "Are you sure you want to cancel all transfers?",
	/** Floating-bar label: number of active transfers (singular). {{count}} is the count */
	transfers_active_one: "{{count}} active transfer",
	/** Floating-bar label: number of active transfers (plural). {{count}} is the count */
	transfers_active_other: "{{count}} active transfers"
} as const
