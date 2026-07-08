// English source catalog — "transfers" namespace: the icon-rail Transfers trigger and its panel
// (components/transfers/*) tracking in-flight and finished uploads AND downloads, plus the
// upload/download-summary toasts startUploads (lib/drive/upload.ts) / startDownloads
// (lib/drive/download.ts) fire once a batch finishes. Same typed-catalog rules as
// common/errors/auth/drive/contacts: flat `as const` object, camelCase keys, no literal '.' or ':'
// (real i18next namespaces, keySeparator/nsSeparator both ON).
//
// No "cancelled"/"completedWithErrors" copy yet — those statuses exist at the store level
// (stores/transfers.ts) but no row in this panel renders them today: a cancelled transfer is removed
// right after settling (never displayed), and completedWithErrors backs a zip transfer no code
// produces yet. Active (uploading/downloading) rows get transfersRowCancel plus a pause/resume
// toggle (transfersRowPause/transfersRowResume); finished rows get transfersRowRemove.
export const transfers = {
	// ── Icon rail ───────────────────────────────────────────────────────────
	/** Icon-rail Transfers trigger — accessible label while at least one upload is active; replaces the plain moduleTransfers label so the count is announced, not just shown in the visual badge; singular */
	transfersActiveBadge_one: "Transfers, {{count}} active",
	/** Icon-rail Transfers trigger — accessible label while at least one upload is active; replaces the plain moduleTransfers label so the count is announced, not just shown in the visual badge; plural */
	transfersActiveBadge_other: "Transfers, {{count}} active",

	// ── Panel ────────────────────────────────────────────────────────────────
	/** Transfers panel — heading */
	transfersPanelTitle: "Transfers",
	/** Transfers panel — empty-state title shown when there are no transfers */
	transfersEmptyTitle: "No transfers",
	/** Transfers panel — empty-state body under transfersEmptyTitle */
	transfersEmptyBody: "Files you upload will appear here.",
	/** Transfers panel — button clearing every finished (done/error) transfer from the list; active uploads are unaffected */
	transfersClearFinished: "Clear finished",

	// ── Row ──────────────────────────────────────────────────────────────────
	/** Transfer row — status label while a file is uploading */
	transfersStatusUploading: "Uploading",
	/** Transfer row — status label once a file finished uploading */
	transfersStatusDone: "Done",
	/** Transfer row — status label when a file failed to upload; the row also surfaces the failing outcome's own error label */
	transfersStatusError: "Failed",
	/** Transfer row — accessible label on the button removing a single finished (done/error) transfer from the list */
	transfersRowRemove: "Remove",
	/** Transfer row — accessible label on the button cancelling a single active (uploading/downloading) transfer */
	transfersRowCancel: "Cancel",
	/** Transfer row — accessible label on the toggle button pausing a single active, not-yet-paused transfer */
	transfersRowPause: "Pause",
	/** Transfer row — accessible label on the toggle button resuming a single active, paused transfer */
	transfersRowResume: "Resume",

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
	/** Download summary toast — the downloaded file succeeded; singular */
	transfersDownloadSummaryComplete_one: "{{count}} file downloaded",
	/** Download summary toast — every downloaded file in the batch succeeded; plural */
	transfersDownloadSummaryComplete_other: "{{count}} files downloaded",
	/** Download summary toast — the download failed; {{count}} = files that succeeded, {{failed}} = files that failed; singular */
	transfersDownloadSummaryCompleteWithFailures_one: "{{count}} file downloaded, {{failed}} failed",
	/** Download summary toast — at least one file in the batch failed; {{count}} = files that succeeded, {{failed}} = files that failed; plural */
	transfersDownloadSummaryCompleteWithFailures_other: "{{count}} files downloaded, {{failed}} failed",

	// ── Zip download (startZipDownload) ───────────────────────────────────────
	/** Suggested filename for a zip download of a multi-item selection (no single item to name it after) — a save-dialog/transfer-row filename, not a sentence; keep the .zip extension */
	transfersZipDownloadDefaultName: "Filen.zip"
} as const
