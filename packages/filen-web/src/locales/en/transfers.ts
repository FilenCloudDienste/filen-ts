// English source catalog — "transfers" namespace: the icon-rail Transfers trigger (a direct nav link
// to the /transfers screen — it no longer opens its own popover) and the full /transfers screen
// (features/transfers/components/*, features/transfers/screens/*) tracking in-flight and finished
// uploads AND downloads, plus the upload/download-summary toasts startUploads (features/drive/lib/upload.ts) /
// startDownloads (features/drive/lib/download.ts) fire once a batch finishes. Same typed-catalog rules as
// common/errors/auth/drive/contacts: flat `as const` object, camelCase keys, no literal '.' or ':'
// (real i18next namespaces, keySeparator/nsSeparator both ON).
//
// No "cancelled"/"completedWithErrors" copy yet — those statuses exist at the store level
// (useTransfersStore.ts) but no row in this panel renders them today: a cancelled transfer is removed
// right after settling (never displayed), and completedWithErrors backs a zip transfer no code
// produces yet. Active (uploading/downloading) rows get transfersRowCancel plus a pause/resume
// toggle (transfersRowPause/transfersRowResume) and, while paused, transfersStatusPaused replaces the
// live percentage; finished rows get transfersRowRemove.
export const transfers = {
	// ── Icon rail ───────────────────────────────────────────────────────────
	/** Icon-rail Transfers trigger — accessible label while at least one upload is active; replaces the plain moduleTransfers label so the count is announced, not just shown in the visual badge; singular */
	transfersActiveBadge_one: "Transfers, {{count}} active",
	/** Icon-rail Transfers trigger — accessible label while at least one upload is active; replaces the plain moduleTransfers label so the count is announced, not just shown in the visual badge; plural */
	transfersActiveBadge_other: "Transfers, {{count}} active",

	// ── Aggregate speed/progress ──────────────────────────────────────
	// Shared by the icon-rail Transfers entry's tooltip and the /transfers screen header — both render
	// the same live rolling-window {percent, speed} useTransfersAggregate computes, gated on
	// shouldShowTransfersAggregate (transfers.logic.ts).
	/** Live aggregate transfer speed readout — {{speed}} is a pre-formatted byte-rate string (e.g. "3.2 MB"); appends the per-second unit */
	transfersAggregateSpeed: "{{speed}}/s",
	/** Accessible label on the aggregate progress bar (icon-rail tooltip context + the /transfers screen header) */
	transfersAggregateProgressLabel: "Overall transfer progress",

	// ── Panel ────────────────────────────────────────────────────────────────
	/** Empty-state title shown when there are no transfers (rail entry's accessible summary + the /transfers screen) */
	transfersEmptyTitle: "No transfers",
	/** Empty-state body under transfersEmptyTitle, used where there's no room to mention both directions */
	transfersEmptyBody: "Files you upload will appear here.",
	/** Button clearing every finished (done/error) transfer from the list; active uploads are unaffected */
	transfersClearFinished: "Clear finished",

	// ── Screen ───────────────────────────────────────────────────────────────
	/** Transfers screen — empty-state body under transfersEmptyTitle (this body mentions both directions since the full page has room to) */
	transfersScreenEmptyBody: "Uploads and downloads will appear here.",
	/** Transfers screen — heading above the section listing in-flight (uploading/downloading) transfers */
	transfersScreenSectionActive: "Active",
	/** Transfers screen — heading above the section listing finished (done/error) transfers */
	transfersScreenSectionFinished: "Finished",
	/** Transfers screen — header button pausing every active, not-yet-paused transfer; disabled when none qualify */
	transfersScreenPauseAll: "Pause all",
	/** Transfers screen — header button resuming every active, paused transfer; disabled when none qualify */
	transfersScreenResumeAll: "Resume all",
	/** Transfers screen — header button opening the Cancel-all confirm dialog; disabled when no transfer is active. Also reused as the confirm dialog's own destructive confirm button label */
	transfersScreenCancelAll: "Cancel all",
	/** Cancel-all confirm dialog — title */
	transfersScreenCancelAllConfirmTitle: "Cancel all transfers?",
	/** Cancel-all confirm dialog — body; {{count}} = active transfers that will stop; singular */
	transfersScreenCancelAllConfirmBody_one: "{{count}} active transfer will stop. This can't be undone.",
	/** Cancel-all confirm dialog — body; {{count}} = active transfers that will stop; plural */
	transfersScreenCancelAllConfirmBody_other: "{{count}} active transfers will stop. This can't be undone.",
	/** Shared dismiss-button label for both the single-row and Cancel-all confirm dialogs — keeps the transfer running */
	transfersCancelDialogDismiss: "Keep transferring",

	// ── Row ──────────────────────────────────────────────────────────────────
	/** Transfer row — status label while a file is uploading */
	transfersStatusUploading: "Uploading",
	/** Transfer row — status label while a file is downloading */
	transfersStatusDownloading: "Downloading",
	/** Transfer row — status label once a file finished uploading */
	transfersStatusDone: "Done",
	/** Transfer row — status label when a file failed to upload; the row also surfaces the failing outcome's own error label */
	transfersStatusError: "Failed",
	/** Transfer row — status label replacing the live percentage while an active (uploading/downloading) transfer is suspended in place */
	transfersStatusPaused: "Paused",
	/** Transfer row — accessible label on the button removing a single finished (done/error) transfer from the list */
	transfersRowRemove: "Remove",
	/** Transfer row — accessible label on the button opening the single-transfer Cancel confirm dialog; also reused as the confirm dialog's own destructive confirm button label */
	transfersRowCancel: "Cancel",
	/** Single-transfer Cancel confirm dialog — title */
	transfersRowCancelConfirmTitle: "Cancel transfer?",
	/** Single-transfer Cancel confirm dialog — body; {{name}} = the transferring file's own name */
	transfersRowCancelConfirmBody: "“{{name}}” is still transferring. This can't be undone.",
	/** Transfer row — accessible label on the toggle button pausing a single active, not-yet-paused transfer */
	transfersRowPause: "Pause",
	/** Transfer row — accessible label on the toggle button resuming a single active, paused transfer */
	transfersRowResume: "Resume",

	// ── Directory upload scan phase ───────────────────────────────────────
	/** Loading toast shown the instant a directory upload/drop starts, for the JS tree-walk scan phase before any transfer row exists yet (uploadDirectory.ts's collectDirectoryUploads) */
	transfersScanningDirectory: "Scanning directory…",

	// ── Upload summary toast (startUploads) ──────────────────────────────────
	/** Upload summary toast — every uploaded file in the batch succeeded; singular */
	transfersUploadSummaryComplete_one: "{{count}} file uploaded",
	/** Upload summary toast — every uploaded file in the batch succeeded; plural */
	transfersUploadSummaryComplete_other: "{{count}} files uploaded",
	/** Upload summary toast — at least one file in the batch failed; {{count}} = files that succeeded, {{failed}} = files that failed; singular */
	transfersUploadSummaryCompleteWithFailures_one: "{{count}} file uploaded, {{failed}} failed",
	/** Upload summary toast — at least one file in the batch failed; {{count}} = files that succeeded, {{failed}} = files that failed; plural */
	transfersUploadSummaryCompleteWithFailures_other: "{{count}} files uploaded, {{failed}} failed",

	// ── Upload summary toast (runDirectoryUpload) ─────────────────────────────
	// Counts BOTH created sub-directories and uploaded files as one "item" (unlike the plain
	// transfersUploadSummary* keys above, which only ever count files) — a directory upload recreates
	// a tree of both, and a directory-only failure (an empty sub-directory that couldn't be created)
	// would otherwise vanish from a files-only count.
	/** Directory-upload summary toast — every created directory and uploaded file in the batch succeeded; singular */
	transfersDirectoryUploadSummaryComplete_one: "{{count}} item uploaded",
	/** Directory-upload summary toast — every created directory and uploaded file in the batch succeeded; plural */
	transfersDirectoryUploadSummaryComplete_other: "{{count}} items uploaded",
	/** Directory-upload summary toast — at least one directory or file in the batch failed; {{count}} = items that succeeded, {{failed}} = items that failed; singular */
	transfersDirectoryUploadSummaryCompleteWithFailures_one: "{{count}} item uploaded, {{failed}} failed",
	/** Directory-upload summary toast — at least one directory or file in the batch failed; {{count}} = items that succeeded, {{failed}} = items that failed; plural */
	transfersDirectoryUploadSummaryCompleteWithFailures_other: "{{count}} items uploaded, {{failed}} failed",

	// ── Download summary toast (startDownloads) ───────────────────────────────
	/** Download summary toast — the download failed; {{count}} = files that succeeded, {{failed}} = files that failed; singular */
	transfersDownloadSummaryCompleteWithFailures_one: "{{count}} file downloaded, {{failed}} failed",
	/** Download summary toast — at least one file in the batch failed; {{count}} = files that succeeded, {{failed}} = files that failed; plural */
	transfersDownloadSummaryCompleteWithFailures_other: "{{count}} files downloaded, {{failed}} failed",

	// ── Zip download (startZipDownload) ───────────────────────────────────────
	/** Suggested filename for a zip download of a multi-item selection (no single item to name it after) — a save-dialog/transfer-row filename, not a sentence; keep the .zip extension */
	transfersZipDownloadDefaultName: "Filen.zip"
} as const
