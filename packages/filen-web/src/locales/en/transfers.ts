// English source catalog — "transfers" namespace: the icon-rail Transfers trigger (a direct nav link
// to the /transfers screen — it no longer opens its own popover) and the full /transfers screen
// (features/transfers/components/*, features/transfers/screens/*) tracking in-flight and finished
// uploads AND downloads, plus the upload/download-summary toasts startUploads (features/drive/lib/upload.ts) /
// startDownloads (features/drive/lib/download.ts) fire once a batch finishes. Same typed-catalog rules as
// common/errors/auth/drive/contacts: flat `as const` object, camelCase keys, no literal '.' or ':'
// (real i18next namespaces, keySeparator/nsSeparator both ON).
//
// No "cancelled" copy — a cancelled transfer is removed right after settling (never displayed). Active
// (uploading/downloading/copying) rows get transfersRowCancel plus a pause/resume
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
	/** Transfers screen — empty-state body under transfersEmptyTitle (names every kind of transfer since the full page has room to) */
	transfersScreenEmptyBody: "Uploads, downloads and copies will appear here.",
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
	/** Transfer row — status label while a copy job runs (one row per copy, however many items it holds) */
	transfersStatusCopying: "Copying",
	/** Transfer row — status label once a file finished uploading */
	transfersStatusDone: "Done",
	/** Transfer row — status label when a file failed to upload; the row also surfaces the failing outcome's own error label */
	transfersStatusError: "Failed",
	/** Transfer row — status label for a copy that finished with some of its items failed; the rest were copied */
	transfersStatusCompletedWithErrors: "Completed with errors",
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

	// ── Upload quota pre-flight (features/drive/lib/quota.ts) ─────────────────
	/** Error toast when a file, directory or attachment upload does not fit the account's free storage; nothing was uploaded; {{needed}} = formatted total size of the upload, {{free}} = formatted free storage */
	transfersQuotaExceeded: "This upload needs {{needed}} but only {{free}} is free.",

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

	// ── Copy (features/drive/lib/copy.ts) ─────────────────────────────────────
	/** Copy transfer row — name of a copy job holding more than one item (a one-item copy shows that item's own name); singular */
	transfersCopyRowName_one: "{{count}} item",
	/** Copy transfer row — name of a copy job holding more than one item (a one-item copy shows that item's own name); plural */
	transfersCopyRowName_other: "{{count}} items",
	/** Copy summary toast — the copy finished and every item was copied; {{count}} = items the user chose to copy; singular */
	transfersCopySummaryComplete_one: "{{count}} item copied",
	/** Copy summary toast — the copy finished and every item was copied; {{count}} = items the user chose to copy; plural */
	transfersCopySummaryComplete_other: "{{count}} items copied",
	/** Copy summary toast — the copy finished but some files or directories could not be copied; the rest were; {{count}} = failed files/directories; singular */
	transfersCopySummaryCompleteWithFailures_one: "Copy finished, {{count}} item failed",
	/** Copy summary toast — the copy finished but some files or directories could not be copied; the rest were; {{count}} = failed files/directories; plural */
	transfersCopySummaryCompleteWithFailures_other: "Copy finished, {{count}} items failed",
	/** Copy error (toast and transfer row) — the copy is larger than the account's free storage; checked after the copy's scan, before anything was written; {{free}} = formatted free storage */
	transfersCopyQuotaExceeded: "This copy doesn't fit the {{free}} of free storage.",

	// ── Copy progress card (features/transfers/components/copyJobToast.tsx) ────
	// A persistent toast per copy job; dismissing hides it and the job's transfers row reopens it.
	/** Copy card — title while copying; {{destination}} = the destination directory's name; singular */
	transfersCopyCardTitleRunning_one: "Copying {{count}} item → {{destination}}",
	/** Copy card — title while copying; {{destination}} = the destination directory's name; plural */
	transfersCopyCardTitleRunning_other: "Copying {{count}} items → {{destination}}",
	/** Copy card — title once every item was copied; singular */
	transfersCopyCardTitleDone_one: "Copied {{count}} item → {{destination}}",
	/** Copy card — title once every item was copied; plural */
	transfersCopyCardTitleDone_other: "Copied {{count}} items → {{destination}}",
	/** Copy card — title once the copy ended any other way (cancelled, failed, some items failed); the line below says how */
	transfersCopyCardTitleEnded: "Copy to {{destination}}",
	/** Copy card — accessible label on the button hiding the card; the copy keeps running and its transfers row reopens the card */
	transfersCopyCardDismiss: "Hide copy progress",
	/** Copy card — accessible label on the progress bar */
	transfersCopyProgressLabel: "Copy progress",
	/** Copy card — status while the copy lists what it has to copy, before anything is written */
	transfersCopyPhaseScanning: "Scanning…",
	/** Copy card — status while the copy recreates the directory tree at the destination */
	transfersCopyPhaseCreatingDirectories: "Creating directories",
	/** Copy card — status while the last files are being finalized */
	transfersCopyPhaseFinishing: "Finishing",
	/** Copy card — status after pause was pressed, while files already in flight finish */
	transfersCopyPhasePausing: "Pausing…",
	/** Copy card — status after stop was confirmed, until the copy has stopped */
	transfersCopyPhaseCancelling: "Stopping…",
	/** Copy card — status while copying files; {{done}} = files copied so far, {{count}} = files to copy; singular */
	transfersCopyFilesProgress_one: "{{done}} of {{count}} file",
	/** Copy card — status while copying files; {{done}} = files copied so far, {{count}} = files to copy; plural */
	transfersCopyFilesProgress_other: "{{done}} of {{count}} files",
	/** Copy card — bytes copied so far out of the total; both pre-formatted sizes */
	transfersCopyBytesProgress: "{{done}} of {{total}}",
	/** Copy card — estimated time left; {{eta}} = a pre-formatted m:ss (or h:mm:ss) duration */
	transfersCopyEta: "{{eta}} left",
	/** Copy card — status when the copy finished but some files or directories could not be copied; singular */
	transfersCopyFailedItems_one: "{{count}} item couldn't be copied",
	/** Copy card — status when the copy finished but some files or directories could not be copied; plural */
	transfersCopyFailedItems_other: "{{count}} items couldn't be copied",
	/** Copy card — status after a stopped copy whose copied items were kept at the destination */
	transfersCopyCancelledKept: "Stopped. What was copied so far was kept.",
	/** Copy card — status after a stopped copy whose copied items were moved to the trash; {{count}} = items moved; singular */
	transfersCopyCancelledTrashed_one: "Stopped. {{count}} copied item was moved to the trash.",
	/** Copy card — status after a stopped copy whose copied items were moved to the trash; {{count}} = items moved; plural */
	transfersCopyCancelledTrashed_other: "Stopped. {{count}} copied items were moved to the trash.",
	/** Copy card — status after a stopped copy when some copied items could not be moved to the trash */
	transfersCopyCancelledTrashFailed: "Stopped. Some copied items couldn't be moved to the trash.",
	/** Copy card — button expanding and collapsing the details section */
	transfersCopyDetails: "Details",
	/** Copy card details — shown when there is nothing to list yet (no file in flight, no failure, no note) */
	transfersCopyNoDetails: "Nothing to report yet.",
	/** Copy card — one-line note while the copy runs: the copy runs in this tab */
	transfersCopyTabNote: "Closing this tab stops the copy.",
	/** Copy card details — heading above the files being copied right now */
	transfersCopyCurrentFiles: "Copying now",
	/** Copy card details — heading above the files and directories that could not be copied */
	transfersCopyFailures: "Couldn't copy",
	/** Copy card details — the failures beyond the listed ones; singular */
	transfersCopyMoreFailures_one: "and {{count}} more",
	/** Copy card details — the failures beyond the listed ones; plural */
	transfersCopyMoreFailures_other: "and {{count}} more",
	/** Copy card details — button copying the failed items again, each into the directory it was meant for */
	transfersCopyRetryFailed: "Retry failed",
	/** Copy card details — note: items copied under another name (the name was taken, or not allowed); singular */
	transfersCopyRenamedNote_one: "{{count}} item got a new name because its name was taken or not allowed.",
	/** Copy card details — note: items copied under another name (the name was taken, or not allowed); plural */
	transfersCopyRenamedNote_other: "{{count}} items got a new name because their names were taken or not allowed.",
	/** Copy card details — note: items left out because they couldn't be decrypted or reached; singular */
	transfersCopySkippedNote_one: "{{count}} item was skipped because it couldn't be decrypted or reached.",
	/** Copy card details — note: items left out because they couldn't be decrypted or reached; plural */
	transfersCopySkippedNote_other: "{{count}} items were skipped because they couldn't be decrypted or reached.",
	/** Copy card details — note: files the server stored as a new version of an existing file of the same name; singular */
	transfersCopySavedAsVersionNote_one: "{{count}} file was saved as a new version of an existing file.",
	/** Copy card details — note: files the server stored as a new version of an existing file of the same name; plural */
	transfersCopySavedAsVersionNote_other: "{{count}} files were saved as new versions of existing files.",
	/** Copy card details — note: copied items that could not join the destination's shares or public links; singular */
	transfersCopyPropagationNote_one: "{{count}} item couldn't be added to the destination's shares or public links.",
	/** Copy card details — note: copied items that could not join the destination's shares or public links; plural */
	transfersCopyPropagationNote_other: "{{count}} items couldn't be added to the destination's shares or public links.",
	/** Copy transfer row — accessible label on the button reopening the copy's progress card */
	transfersRowCopyDetails: "Show copy progress",
	/** Copy cancel dialog — title */
	transfersCopyCancelTitle: "Stop copying?",
	/** Copy cancel dialog — body; {{destination}} = the destination directory's name */
	transfersCopyCancelBody: "Items already copied to {{destination}} can stay there or move to the trash.",
	/** Copy cancel dialog — dismiss button; the copy keeps running */
	transfersCopyCancelContinue: "Continue copying",
	/** Copy cancel dialog — stops the copy and moves the top-level items it created to the trash (never a permanent delete) */
	transfersCopyCancelTrash: "Move copied items to trash",
	/** Copy cancel dialog — default button; stops the copy and keeps what was copied */
	transfersCopyCancelKeep: "Stop and keep copied items",

	// ── Zip download (startZipDownload) ───────────────────────────────────────
	/** Suggested filename for a zip download of a multi-item selection (no single item to name it after) — a save-dialog/transfer-row filename, not a sentence; keep the .zip extension */
	transfersZipDownloadDefaultName: "Filen.zip"
} as const
