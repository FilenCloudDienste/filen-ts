// English source catalog — "transfers" namespace: the icon-rail Transfers trigger (a direct nav link
// to the /transfers screen — it no longer opens its own popover) and the full /transfers screen
// (features/transfers/components/*, features/transfers/screens/*) tracking in-flight and finished
// uploads, downloads, copies and archive jobs (compress, extract), plus the upload/download-summary toasts startUploads (features/drive/lib/upload.ts) /
// startDownloads (features/drive/lib/download.ts) fire once a batch finishes. Same typed-catalog rules as
// common/errors/auth/drive/contacts: flat `as const` object, camelCase keys, no literal '.' or ':'
// (real i18next namespaces, keySeparator/nsSeparator both ON).
//
// No "cancelled" copy — a cancelled transfer is removed right after settling (never displayed). Active
// (uploading/downloading/copying/compressing/extracting) rows get transfersRowCancel plus a pause/resume
// toggle (transfersRowPause/transfersRowResume) and, while paused, transfersStatusPaused replaces the
// live percentage; finished rows get transfersRowRemove.
export const transfers = {
	// ── Icon rail ───────────────────────────────────────────────────────────
	/** Icon-rail Transfers trigger — accessible label while at least one upload is active; replaces the plain moduleTransfers label so the count is announced, not just shown in the visual badge; singular */
	transfersActiveBadge_one: "Transfers, {{count}} active",
	/** Icon-rail Transfers trigger — accessible label while at least one upload is active; replaces the plain moduleTransfers label so the count is announced, not just shown in the visual badge; plural */
	transfersActiveBadge_other: "Transfers, {{count}} active",

	// ── Panel ────────────────────────────────────────────────────────────────
	/** Empty-state title shown when there are no transfers (rail entry's accessible summary + the /transfers screen) */
	transfersEmptyTitle: "No transfers",
	/** Button clearing every finished (done/error) transfer from the list; active uploads are unaffected */
	transfersClearFinished: "Clear finished",

	// ── Screen ───────────────────────────────────────────────────────────────
	/** Transfers screen — empty-state body under transfersEmptyTitle (names every kind of transfer since the full page has room to) */
	transfersScreenEmptyBody: "Uploads, downloads, copies and archive jobs appear here.",
	/** Transfers screen — heading above the section listing in-flight (uploading/downloading) transfers */
	transfersScreenSectionActive: "Active",
	/** Transfers screen — heading above the section listing finished (done/error) transfers */
	transfersScreenSectionFinished: "Finished",
	/** Transfers screen header — how many transfers are running; singular */
	transfersScreenActiveCount_one: "{{count}} active",
	/** Transfers screen header — how many transfers are running; plural */
	transfersScreenActiveCount_other: "{{count}} active",
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
	/** Transfer row — status label while a compress job writes its archive (one row per archive) */
	transfersStatusCompressing: "Compressing",
	/** Transfer row — status label while an extract job unpacks its archive (one row per archive) */
	transfersStatusExtracting: "Extracting",
	/** Transfer row and job card — status of an archive job queued behind another: the browser tab runs one archive job (compress, extract or archive listing) at a time */
	transfersStatusWaitingForSlot: "Waiting for another archive job",
	/** Transfer row — status label once a transfer finished, where no direction-specific word applies */
	transfersStatusDone: "Done",
	/** Transfer row — status label once an upload finished */
	transfersStatusUploaded: "Uploaded",
	/** Transfer row — status label once a download finished */
	transfersStatusDownloaded: "Downloaded",
	/** Transfer row — status label once a copy finished with every item copied */
	transfersStatusCopied: "Copied",
	/** Transfer row — status label once a compress job saved its archive */
	transfersStatusCompressed: "Compressed",
	/** Transfer row — status label once an extract job unpacked its archive */
	transfersStatusExtracted: "Extracted",
	/** Transfer row — bytes moved so far out of the total; both pre-formatted sizes */
	transfersRowBytesProgress: "{{done}} of {{total}}",
	/** Transfer row — estimated time left; {{eta}} = a pre-formatted m:ss (or h:mm:ss) duration */
	transfersRowTimeLeft: "{{eta}} left",
	/** Transfer row and archive job card — button opening the directory a finished upload, copy, archive or extracted directory landed in, with the item selected */
	transfersRowShowInDirectory: "Show in directory",
	/** Transfer row — status label when a file failed to upload; the row also surfaces the failing outcome's own error label */
	transfersStatusError: "Failed",
	/** Transfer row — status label for a copy that finished with some of its items failed; the rest were copied */
	transfersStatusCompletedWithErrors: "Completed with errors",
	/** Transfer row — status label replacing the live percentage while an active (uploading/downloading) transfer is suspended in place */
	transfersStatusPaused: "Paused",
	/** Transfer row — status label replacing the live percentage of a stopped copy while the items it copied are being moved to the trash, as the user asked when stopping it */
	transfersStatusMovingToTrash: "Moving to trash…",
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
	/** Under a failed or cancelled download the browser itself was saving: browsers keep the part already downloaded (for their own retry), and only the browser's downloads list can delete it */
	transfersBrowserKeptPartialHint: "Your browser may have kept the part already downloaded. Delete it from the browser's downloads list.",

	// ── Transfer start toast (features/transfers/lib/transferStartToast.tsx) ───
	/** Toast shown once a download of a single file or directory has started; {{name}} = the file's name, or the zip's for a directory */
	transfersDownloadStarted: "Downloading {{name}}",
	/** Toast shown once a zip download of several items has started; singular */
	transfersDownloadStartedItems_one: "Downloading {{count}} item",
	/** Toast shown once a zip download of several items has started; plural */
	transfersDownloadStartedItems_other: "Downloading {{count}} items",
	/** Toast shown once an upload of a single file or directory has started; {{name}} = its name */
	transfersUploadStarted: "Uploading {{name}}",
	/** Toast shown once an upload of several picked or dropped files has started; singular */
	transfersUploadStartedFiles_one: "Uploading {{count}} file",
	/** Toast shown once an upload of several picked or dropped files has started; plural */
	transfersUploadStartedFiles_other: "Uploading {{count}} files",
	/** Toast shown once an upload of several dropped files and directories has started; singular */
	transfersUploadStartedItems_one: "Uploading {{count}} item",
	/** Toast shown once an upload of several dropped files and directories has started; plural */
	transfersUploadStartedItems_other: "Uploading {{count}} items",
	/** Transfer start toast — action opening the transfers screen */
	transfersStartedView: "View",

	// ── Copy (features/drive/lib/copy.ts) ─────────────────────────────────────
	/** Copy transfer row — name of a copy job holding more than one item (a one-item copy shows that item's own name); singular */
	transfersCopyRowName_one: "{{count}} item",
	/** Copy transfer row — name of a copy job holding more than one item (a one-item copy shows that item's own name); plural */
	transfersCopyRowName_other: "{{count}} items",
	/** Copy error (progress card and transfer row) — the copy is larger than the account's free storage; checked after the copy's scan, before anything was written; {{needed}} = formatted size of the copy, {{free}} = formatted free storage */
	transfersCopyQuotaExceeded: "This copy needs {{needed}} but only {{free}} is free.",

	// ── Copy progress card (features/transfers/components/driveJobToast.tsx) ───
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
	/** Copy card — status while the copy lists what it has to copy, before anything is written; also a compress card's while it starts listing */
	transfersCopyPhaseScanning: "Scanning…",
	/** Copy card — status while the copy recreates the directory tree at the destination */
	transfersCopyPhaseCreatingDirectories: "Creating directories",
	/** Job card (copy, compress, extract) — status while the last files are being finalized */
	transfersCopyPhaseFinishing: "Finishing",
	/** Job card (copy, compress, extract) — status after pause was pressed, while files already in flight finish */
	transfersCopyPhasePausing: "Pausing…",
	/** Job card (copy, compress, extract) — status after stop was confirmed, until the job has stopped */
	transfersCopyPhaseCancelling: "Stopping…",
	/** Job card (copy, compress, extract) — status while files are processed; {{done}} = files done so far, {{count}} = files to do; singular */
	transfersCopyFilesProgress_one: "{{done}} of {{count}} file",
	/** Job card (copy, compress, extract) — status while files are processed; {{done}} = files done so far, {{count}} = files to do; plural */
	transfersCopyFilesProgress_other: "{{done}} of {{count}} files",
	/** Job card (copy, compress, extract) — bytes done so far out of the total; both pre-formatted sizes */
	transfersCopyBytesProgress: "{{done}} of {{total}}",
	/** Job card (copy, compress, extract) — estimated time left; {{eta}} = a pre-formatted m:ss (or h:mm:ss) duration */
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
	/** Copy card — status of a copy that ended before its "Move copied items to trash" stop reached it, once its copied items were moved to the trash; for a failed copy it follows the error; {{count}} = items moved; singular */
	transfersCopyTrashed_one: "{{count}} copied item was moved to the trash.",
	/** Copy card — status of a copy that ended before its "Move copied items to trash" stop reached it, once its copied items were moved to the trash; for a failed copy it follows the error; {{count}} = items moved; plural */
	transfersCopyTrashed_other: "{{count}} copied items were moved to the trash.",
	/** Copy card — status of a copy that ended before its "Move copied items to trash" stop reached it, when some copied items could not be moved to the trash; for a failed copy it follows the error */
	transfersCopyTrashFailed: "Some copied items couldn't be moved to the trash.",
	/** Copy card — status once a copy stopped with "Move copied items to trash" has ended, while the items it copied are being moved to the trash */
	transfersCopyMovingToTrash: "Moving copied items to the trash…",
	/** Copy transfer row — error line of a stopped copy whose copied items could not all be moved to the trash; they are still at the destination; singular */
	transfersCopyTrashFailedItems_one: "{{count}} copied item couldn't be moved to the trash",
	/** Copy transfer row — error line of a stopped copy whose copied items could not all be moved to the trash; they are still at the destination; plural */
	transfersCopyTrashFailedItems_other: "{{count}} copied items couldn't be moved to the trash",
	/** Job card (copy, compress, extract) — error line for a failed item or a failed job when the error has no text of its own for the user */
	transfersCopyErrorGeneric: "Something went wrong.",
	/** Job card (copy, compress, extract) — button expanding and collapsing the details section */
	transfersCopyDetails: "Details",
	/** Job card (copy, compress, extract) details — shown when there is nothing to list yet (no file in flight, no failure, no note) */
	transfersCopyNoDetails: "Nothing to report yet.",
	/** Copy card — one-line note while the copy runs: the copy runs in this tab */
	transfersCopyTabNote: "Closing this tab stops the copy.",
	/** Copy card details — heading above the files being copied right now */
	transfersCopyCurrentFiles: "Copying now",
	/** Copy card details — heading above the files and directories that could not be copied */
	transfersCopyFailures: "Couldn't copy",
	/** Job card (copy, extract) details — the failures beyond the listed ones; singular */
	transfersCopyMoreFailures_one: "and {{count}} more",
	/** Job card (copy, extract) details — the failures beyond the listed ones; plural */
	transfersCopyMoreFailures_other: "and {{count}} more",
	/** Job card — button running the failed items again, each into the directory it was meant for; a copy's sits in its details, an extract's beside the card's other result actions */
	transfersCopyRetryFailed: "Retry failed",
	/** Job card (copy, compress, extract) details — note: items created under another name (the name was taken, or not allowed); singular */
	transfersCopyRenamedNote_one: "{{count}} item got a new name because its name was taken or not allowed.",
	/** Job card (copy, compress, extract) details — note: items created under another name (the name was taken, or not allowed); plural */
	transfersCopyRenamedNote_other: "{{count}} items got a new name because their names were taken or not allowed.",
	/** Job card (copy, compress) details — note: items left out because they couldn't be decrypted or reached; singular */
	transfersCopySkippedNote_one: "{{count}} item was skipped because it couldn't be decrypted or reached.",
	/** Job card (copy, compress) details — note: items left out because they couldn't be decrypted or reached; plural */
	transfersCopySkippedNote_other: "{{count}} items were skipped because they couldn't be decrypted or reached.",
	/** Job card (copy, extract) details — note: files the server stored as a new version of an existing file of the same name; singular */
	transfersCopySavedAsVersionNote_one: "{{count}} file was saved as a new version of an existing file.",
	/** Job card (copy, extract) details — note: files the server stored as a new version of an existing file of the same name; plural */
	transfersCopySavedAsVersionNote_other: "{{count}} files were saved as new versions of existing files.",
	/** Job card (copy, compress, extract) details — note: created items that could not join the destination's shares or public links; singular */
	transfersCopyPropagationNote_one: "{{count}} item couldn't be added to the destination's shares or public links.",
	/** Job card (copy, compress, extract) details — note: created items that could not join the destination's shares or public links; plural */
	transfersCopyPropagationNote_other: "{{count}} items couldn't be added to the destination's shares or public links.",
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

	// ── Job progress cards (features/transfers/components/driveJobToast.tsx) ──
	// Copy's card keeps its own keys above; these are shared by the compress and extract cards.
	/** Copy transfer row — accessible label on the button reopening the copy's progress card */
	transfersRowCopyDetails: "Show copy progress",
	/** Compress transfer row — accessible label on the button reopening the compress's progress card */
	transfersRowCompressDetails: "Show compress progress",
	/** Extract transfer row — accessible label on the button reopening the extract's progress card */
	transfersRowExtractDetails: "Show extract progress",
	/** Compress/extract card — button opening the job's report dialog: every failed, skipped and renamed item and what became of the originals */
	transfersJobViewReport: "View report",
	/** Extract card — button asking for the archive's password and running the extract again with it */
	transfersJobEnterPassword: "Enter password",
	/** Compress card — button running a compress that failed (or did not fit the free storage) again, as it was asked for */
	transfersJobRerun: "Try again",
	/** Compress/extract card — status of a job that finished but left something to look at (skipped or failed items, originals kept); the details and the report say what */
	transfersJobDoneWithIssues: "Done, with issues. See the details.",
	/** Compress/extract card — warning while this job is paused: it keeps the tab's one archive slot, so the archive jobs queued behind it cannot start */
	transfersJobSlotHeldWarning: "This paused job holds the only archive slot. Other archive jobs wait until it resumes or stops.",
	/** Compress/extract card — status while the originals are moved to the trash after the job, as the user chose */
	transfersArchivePhaseTrashingOriginals: "Moving originals to the trash…",
	/** Compress/extract card — status while the originals are deleted permanently after the job, as the user chose */
	transfersArchivePhaseDeletingOriginals: "Deleting originals…",
	/** Compress/extract card details — note: originals that were to be removed after the job but were kept, each for a reason the report gives; singular */
	transfersArchiveOriginalsKeptNote_one: "{{count}} original was kept. The report says why.",
	/** Compress/extract card details — note: originals that were to be removed after the job but were kept, each for a reason the report gives; plural */
	transfersArchiveOriginalsKeptNote_other: "{{count}} originals were kept. The report says why.",
	/** Compress/extract card — error when the job did not fit the account's free storage and how much it needed is unknown; {{free}} = formatted free storage */
	transfersArchiveQuotaUnknown: "There isn't enough free storage. Only {{free}} is free.",

	// ── Compress card ─────────────────────────────────────────────────────────
	/** Compress card — title while compressing; {{count}} = items selected, {{name}} = the archive's file name; singular */
	transfersCompressCardTitleRunning_one: "Compressing {{count}} item into {{name}}",
	/** Compress card — title while compressing; {{count}} = items selected, {{name}} = the archive's file name; plural */
	transfersCompressCardTitleRunning_other: "Compressing {{count}} items into {{name}}",
	/** Compress card — title once the archive was saved; {{count}} = items selected, {{name}} = the archive's file name; singular */
	transfersCompressCardTitleDone_one: "Compressed {{count}} item into {{name}}",
	/** Compress card — title once the archive was saved; {{count}} = items selected, {{name}} = the archive's file name; plural */
	transfersCompressCardTitleDone_other: "Compressed {{count}} items into {{name}}",
	/** Compress card — title once the compress ended without an archive (stopped, failed); the line below says how; {{name}} = the archive's file name */
	transfersCompressCardTitleEnded: "Compress into {{name}}",
	/** Compress card — accessible label on the button hiding the card; the compress keeps running and its transfers row reopens the card */
	transfersCompressCardDismiss: "Hide compress progress",
	/** Compress card — accessible label on the progress bar */
	transfersCompressProgressLabel: "Compress progress",
	/** Compress card — one-line note while the compress runs: it runs in this tab */
	transfersCompressTabNote: "Closing this tab stops compressing.",
	/** Compress card details — heading above the file being read into the archive right now */
	transfersCompressCurrentFiles: "Compressing now",
	/** Compress card — status while the selected items are listed; {{done}} = items listed so far, {{count}} = items selected; singular */
	transfersCompressPhaseListing_one: "Listing {{done}} of {{count}} item",
	/** Compress card — status while the selected items are listed; {{done}} = items listed so far, {{count}} = items selected; plural */
	transfersCompressPhaseListing_other: "Listing {{done}} of {{count}} items",
	/** Compress card — status while the saved archive is read back and checked, before the originals are deleted permanently */
	transfersCompressPhaseVerifying: "Checking the archive…",
	/** Compress card — status of a stopped compress: no archive was saved and nothing else was changed */
	transfersCompressCancelled: "Stopped. Nothing was left behind.",
	/** Compress card — error when the archive does not fit the account's free storage; {{needed}} = formatted size it needs, {{free}} = formatted free storage */
	transfersCompressQuotaExceeded: "This archive needs {{needed}} but only {{free}} is free.",
	/** Compress card details — note: files whose data did not match the checksum stored with them, so their copy in the archive may be damaged; singular */
	transfersCompressHashMismatchNote_one: "{{count}} file didn't match its stored checksum and may be damaged.",
	/** Compress card details — note: files whose data did not match the checksum stored with them, so their copy in the archive may be damaged; plural */
	transfersCompressHashMismatchNote_other: "{{count}} files didn't match their stored checksums and may be damaged.",
	/** Compress card details — note: the stop came after the archive was saved, so the archive stays; what became of the originals is noted apart */
	transfersCompressStoppedAfterArchiveNote: "The archive was already saved when the job stopped, so it was kept.",
	/** Compress card details — note: the archive was saved after the job had already ended with an error */
	transfersCompressLateArchiveNote: "The archive was saved after the job had already ended.",
	/** Compress cancel dialog — title */
	transfersCompressCancelTitle: "Stop compressing?",
	/** Compress cancel dialog — body while the archive is still being written: stopping discards it and changes nothing else */
	transfersCompressCancelBody: "Stopping leaves nothing behind.",
	/** Compress cancel dialog — body once the archive is saved and is being checked or its originals removed, some of which may already be gone; {{destination}} = the directory it was saved in */
	transfersCompressCancelBodyAfterArchive:
		"The archive is already saved in {{destination}}. Stopping now keeps the originals not yet removed.",
	/** Compress cancel dialog — dismiss button; the compress keeps running */
	transfersCompressCancelContinue: "Continue compressing",
	/** Compress cancel dialog — default button; stops the compress */
	transfersCompressCancelStop: "Stop compressing",

	// ── Extract card ──────────────────────────────────────────────────────────
	// Not named …Running/…Done: activity toasts (lib/activity) read keys with that suffix as plural pairs.
	/** Extract card — title while extracting; {{name}} = the archive's file name, {{destination}} = the directory it is extracted into */
	transfersExtractCardTitleExtracting: "Extracting {{name}} → {{destination}}",
	/** Extract card — title once everything that could be extracted was; {{name}} = the archive's file name, {{destination}} = the directory it was extracted into */
	transfersExtractCardTitleExtracted: "Extracted {{name}} → {{destination}}",
	/** Extract card — title once the extract ended any other way (stopped, failed, password needed); the line below says how */
	transfersExtractCardTitleEnded: "Extract {{name}} → {{destination}}",
	/** Extract card — accessible label on the button hiding the card; the extract keeps running and its transfers row reopens the card */
	transfersExtractCardDismiss: "Hide extract progress",
	/** Extract card — accessible label on the progress bar */
	transfersExtractProgressLabel: "Extract progress",
	/** Extract card — one-line note while the extract runs: it runs in this tab */
	transfersExtractTabNote: "Closing this tab stops extracting.",
	/** Extract card details — heading above the files being extracted right now */
	transfersExtractCurrentFiles: "Extracting now",
	/** Extract card details — heading above the entries that could not be extracted */
	transfersExtractFailures: "Couldn't extract",
	/** Extract card — status while the archive's entries are read, before anything is created */
	transfersExtractPhaseScanning: "Reading the archive…",
	/** Extract card — status while extracting when the number of files to come is unknown; {{count}} = files extracted so far; singular */
	transfersExtractFilesExtracted_one: "{{count}} file extracted",
	/** Extract card — status while extracting when the number of files to come is unknown; {{count}} = files extracted so far; plural */
	transfersExtractFilesExtracted_other: "{{count}} files extracted",
	/** Extract card — status when the extract finished but some entries could not be extracted; singular */
	transfersExtractFailedItems_one: "{{count}} item couldn't be extracted",
	/** Extract card — status when the extract finished but some entries could not be extracted; plural */
	transfersExtractFailedItems_other: "{{count}} items couldn't be extracted",
	/** Extract card — result line once the extract ended; {{extracted}} = files extracted, {{skipped}} = entries left out, {{failed}} = entries that failed */
	transfersExtractSummary: "{{extracted}} extracted · {{skipped}} skipped · {{failed}} failed",
	/** Extract card — status when the archive is encrypted and no password was given; Enter password runs it again */
	transfersExtractPasswordRequired: "This archive is protected by a password.",
	/** Extract card — status when the given password does not open the archive; Enter password runs it again */
	transfersExtractWrongPassword: "The password is wrong.",
	/** Extract card — error when the extracted files do not fit the account's free storage; {{needed}} = formatted size they need, {{free}} = formatted free storage */
	transfersExtractQuotaExceeded: "Extracting needs {{needed}} but only {{free}} is free.",
	/** Extract card — warning: extracted names holding invisible, control or text-direction characters that make them read as something they are not (an .exe shown as a .pdf); singular */
	transfersExtractMisleadingNamesWarning_one:
		"{{count}} extracted name holds hidden characters that can make it look like something else. Check it before opening.",
	/** Extract card — warning: extracted names holding invisible, control or text-direction characters that make them read as something they are not (an .exe shown as a .pdf); plural */
	transfersExtractMisleadingNamesWarning_other:
		"{{count}} extracted names hold hidden characters that can make them look like something else. Check them before opening.",
	/** Extract card details — note: entries left out on purpose (links, devices, unsafe paths, macOS metadata); the report lists why; singular */
	transfersExtractSkippedNote_one: "{{count}} entry was skipped. The report says why.",
	/** Extract card details — note: entries left out on purpose (links, devices, unsafe paths, macOS metadata); the report lists why; plural */
	transfersExtractSkippedNote_other: "{{count}} entries were skipped. The report says why.",
	/** Extract card details — note following the skipped note: how many of the skipped entries were macOS metadata (__MACOSX, ._ files), left out by choice; singular */
	transfersExtractMacMetadataNote_one: "{{count}} of them was macOS metadata.",
	/** Extract card details — note following the skipped note: how many of the skipped entries were macOS metadata (__MACOSX, ._ files), left out by choice; plural */
	transfersExtractMacMetadataNote_other: "{{count}} of them were macOS metadata.",
	/** Extract card details — note: directories this extract had created that it moved to the trash once the password turned out wrong, so a new try starts clean; singular */
	transfersExtractTopLevelTrashedNote_one: "{{count}} directory created before the password turned out wrong was moved to the trash.",
	/** Extract card details — note: directories this extract had created that it moved to the trash once the password turned out wrong, so a new try starts clean; plural */
	transfersExtractTopLevelTrashedNote_other:
		"{{count}} directories created before the password turned out wrong were moved to the trash.",
	/** Extract card — status after a stopped extract whose extracted items were kept at the destination */
	transfersExtractCancelledKept: "Stopped. What was extracted so far was kept.",
	/** Extract card — status after a stopped extract whose extracted items were moved to the trash; {{count}} = items moved; singular */
	transfersExtractCancelledTrashed_one: "Stopped. {{count}} extracted item was moved to the trash.",
	/** Extract card — status after a stopped extract whose extracted items were moved to the trash; {{count}} = items moved; plural */
	transfersExtractCancelledTrashed_other: "Stopped. {{count}} extracted items were moved to the trash.",
	/** Extract card — status after a stopped extract when some extracted items could not be moved to the trash */
	transfersExtractCancelledTrashFailed: "Stopped. Some extracted items couldn't be moved to the trash.",
	/** Extract card — status of an extract that ended before its "move extracted items to trash" stop reached it, once its items were moved to the trash; for a failed extract it follows the error; {{count}} = items moved; singular */
	transfersExtractTrashed_one: "{{count}} extracted item was moved to the trash.",
	/** Extract card — status of an extract that ended before its "move extracted items to trash" stop reached it, once its items were moved to the trash; for a failed extract it follows the error; {{count}} = items moved; plural */
	transfersExtractTrashed_other: "{{count}} extracted items were moved to the trash.",
	/** Extract card — status of an extract that ended before its "move extracted items to trash" stop reached it, when some items could not be moved to the trash; for a failed extract it follows the error */
	transfersExtractTrashFailed: "Some extracted items couldn't be moved to the trash.",
	/** Extract card — status once an extract stopped with "move extracted items to trash" has ended, while the items it extracted are being moved to the trash */
	transfersExtractMovingToTrash: "Moving extracted items to the trash…",
	/** Extract cancel dialog — title */
	transfersExtractCancelTitle: "Stop extracting?",
	/** Extract cancel dialog — body; {{destination}} = the directory the archive is extracted into */
	transfersExtractCancelBody: "Items already extracted to {{destination}} can stay there or move to the trash.",
	/** Extract cancel dialog — body once everything is extracted and the archive is being removed, as the user chose; stopping can no longer move the extracted items to the trash; {{destination}} = the directory the archive was extracted into */
	transfersExtractCancelBodyDisposing:
		"Everything is already extracted to {{destination}} and the archive is being removed. Stopping now keeps the extracted items, and the archive if it is not gone yet.",
	/** Extract cancel dialog — dismiss button; the extract keeps running */
	transfersExtractCancelContinue: "Continue extracting",
	/** Extract cancel dialog — stops the extract and moves the top-level items it created to the trash (never a permanent delete) */
	transfersExtractCancelTrash: "Stop and move extracted items to trash",
	/** Extract cancel dialog — default button; stops the extract and keeps what was extracted */
	transfersExtractCancelKeep: "Stop and keep extracted items",

	// ── Zip download (startZipDownload) ───────────────────────────────────────
	/** Suggested filename for a zip download of a multi-item selection (no single item to name it after) — a save-dialog/transfer-row filename, not a sentence; keep the .zip extension */
	transfersZipDownloadDefaultName: "Filen.zip"
} as const
