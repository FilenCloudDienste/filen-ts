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
	/** Advanced settings (Android only) — warning subtitle shown when the toggle is on but the OS notification permission was revoked, so background transfers can't run */
	background_transfers_notifications_disabled: "Notifications are off, so background transfers won't run. Tap to open settings.",
	/** Advanced settings (Android only) — alert message when notification permission is denied and the user tries to enable background transfers */
	background_transfers_notifications_required: "Allow notifications to run transfers in the background.",
	/** Generic action to open the system settings app (used in permission-denied alerts) */
	open_settings: "Open settings",
	/** Transfers — empty-state subtitle when there are no active or finished transfers */
	no_transfers_description: "Your uploads and downloads will appear here.",
	/** Copy transfer row name when a copy holds several items (singular). {{count}} is the item count */
	copy_n_items_one: "{{count}} item",
	/** Copy transfer row name when a copy holds several items (plural). {{count}} is the item count */
	copy_n_items_other: "{{count}} items",
	/** Floating-bar label while only copies run (singular). {{count}} is the number of items being copied */
	copying_items_one: "Copying {{count}} item",
	/** Floating-bar label while only copies run (plural). {{count}} is the number of items being copied */
	copying_items_other: "Copying {{count}} items",
	/** Android transfers notification body while only copies run (singular). {{count}} items, {{percent}} overall progress, {{speed}} human-readable speed */
	copying_progress_one: "Copying {{count}} item · {{percent}}% · {{speed}}",
	/** Android transfers notification body while only copies run (plural). {{count}} items, {{percent}} overall progress, {{speed}} human-readable speed */
	copying_progress_other: "Copying {{count}} items · {{percent}}% · {{speed}}",
	/** Transfers row title of a running copy. {{name}} is the item's name or "12 items" */
	copy_row_title: "Copying {{name}}",
	/** Transfers row title of a finished copy. {{name}} is the item's name or "12 items" */
	copy_row_finished_title: "Copied {{name}}",
	/** Copy row status while the copy measures what it will copy */
	copy_preparing: "Preparing…",
	/** Copy row status while files are copied. {{done}} and {{total}} are file counts, {{percent}} the overall progress */
	copy_progress_files: "{{done}} of {{total}} files · {{percent}}%",
	/** Copy row status while the copy is paused */
	copy_paused: "Paused",
	/** Copy row status while the copy wraps up after the last file */
	copy_finishing: "Finishing…",
	/** Copy row status after the user stopped the copy, until it has stopped */
	copy_stopping: "Stopping…",
	/** Finished copy row notes: entries that could not be copied and were left out (undecryptable or unreachable). {{count}} is the number */
	copy_notes_skipped: "{{count}} skipped",
	/** Finished copy row notes: items that got a new name because the name was taken. {{count}} is the number */
	copy_notes_renamed: "{{count}} renamed",
	/** Finished copy row notes: files stored as a new version of an existing file. {{count}} is the number */
	copy_notes_saved_as_version: "{{count}} saved as a new version",
	/** Finished copy row notes: items whose sharing or public links could not be applied to the copy. {{count}} is the number */
	copy_notes_sharing_not_applied: "sharing not applied to {{count}}",
	/** Title of the dialog asking how to stop a running copy */
	copy_stop_title: "Stop copying?",
	/** Message of the dialog asking how to stop a running copy. {{done}} and {{total}} are file counts */
	copy_stop_message: "{{done}} of {{total}} files are already copied.",
	/** Stop-copy dialog: stop and keep everything copied so far */
	copy_stop_keep: "Stop and keep copied items",
	/** Stop-copy dialog: stop and move everything this copy created to the trash */
	copy_stop_trash: "Move copied items to trash",
	/** Stop-copy dialog: close the dialog and let the copy go on */
	copy_continue: "Continue copying",
	/** Finished copy row menu: start a new copy of only the items that failed */
	copy_retry_failed: "Retry failed items",
	/** Error shown when an upload or copy would not fit the account's free storage; nothing was sent. {{needed}} and {{free}} are formatted sizes */
	not_enough_storage: "Not enough storage: needs {{needed}}, {{free}} free."
} as const
