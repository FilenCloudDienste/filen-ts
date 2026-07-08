// English source catalog — "transfers" namespace: the icon-rail Transfers trigger and its panel
// (components/transfers/*) tracking in-flight and finished uploads, plus the upload-summary toast
// startUploads (lib/drive/upload.ts) fires once a batch of files finishes. Same typed-catalog rules
// as common/errors/auth/drive/contacts: flat `as const` object, camelCase keys, no literal '.' or
// ':' (real i18next namespaces, keySeparator/nsSeparator both ON).
//
// No "cancelled" status/copy — cancel/abort isn't wired up yet (stores/transfers.ts), so uploading
// rows in the panel have no cancel/remove control, only finished (done/error) rows do
// (transfersRowRemove).
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

	// ── Upload summary toast (startUploads) ──────────────────────────────────
	/** Upload summary toast — every uploaded file in the batch succeeded; singular */
	transfersUploadSummaryComplete_one: "{{count}} file uploaded",
	/** Upload summary toast — every uploaded file in the batch succeeded; plural */
	transfersUploadSummaryComplete_other: "{{count}} files uploaded",
	/** Upload summary toast — at least one file in the batch failed; {{count}} = files that succeeded, {{failed}} = files that failed; singular */
	transfersUploadSummaryCompleteWithFailures_one: "{{count}} file uploaded, {{failed}} failed",
	/** Upload summary toast — at least one file in the batch failed; {{count}} = files that succeeded, {{failed}} = files that failed; plural */
	transfersUploadSummaryCompleteWithFailures_other: "{{count}} files uploaded, {{failed}} failed"
} as const
