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
	transfers_active_other: "{{count}} active transfers",
	/** Android foreground-service notification name for the persistent transfers channel (shown in system notification settings) */
	transfers_channel_name: "Transfers",
	/** Android foreground-service notification body while transfers run (singular). {{count}} is the transfer count, {{percent}} the overall progress, {{speed}} the human-readable speed */
	transfers_progress_one: "{{count}} transfer · {{percent}}% · {{speed}}",
	/** Android foreground-service notification body while transfers run (plural). {{count}} is the transfer count, {{percent}} the overall progress, {{speed}} the human-readable speed */
	transfers_progress_other: "{{count}} transfers · {{percent}}% · {{speed}}",
	/** Finished-transfer row outcome label shown when a transfer completed successfully */
	transfer_completed: "Completed",
	/** Finished-transfer row outcome label: directory transfer resolved but {{count}} entries failed (singular) */
	transfer_completed_with_errors_one: "Completed with {{count}} error",
	/** Finished-transfer row outcome label: directory transfer resolved but {{count}} entries failed (plural) */
	transfer_completed_with_errors_other: "Completed with {{count}} errors",
	/** Finished-transfer row outcome label shown when a transfer failed with an error */
	transfer_failed: "Failed",
	/** Finished-transfer row menu action: remove this single finished entry from the transfers list */
	transfer_remove_from_list: "Remove from list",
	/** Header menu action: remove all finished (completed/failed) entries from the transfers list */
	transfers_clear_finished: "Clear finished",
	/** Advanced settings (Android only) — toggle title for the transfers foreground service */
	background_transfers: "Background transfers",
	/** Advanced settings (Android only) — subtitle under the background-transfers toggle, explaining the persistent notification trade-off */
	background_transfers_description:
		"Keep uploads and downloads running while the app is in the background. Shows a persistent notification while transfers are active.",
	/** Transfers — empty-state subtitle when there are no active or finished transfers */
	no_transfers_description: "Your uploads and downloads will appear here."
} as const
