// "preview" namespace, video editor — the header (Cancel, Revert, Save), the Save popover's summary and settings, and
// the export's progress. Spread into preview.ts; same catalog rules.
export const previewVideoSave = {
	/** Video editor header — leave the editor (asks first over unsaved edits) */
	previewVideoSaveCancel: "Cancel",
	/** Video editor header — undo every edit, back to the video as it was opened */
	previewVideoSaveRevert: "Revert",
	/** Video editor header — opens the Save popover (summary, settings, Save and Save as copy) */
	previewVideoSaveOpen: "Save",
	/** Save popover — save the edited video as a new version of the same file */
	previewVideoSaveInPlace: "Save",
	/** Save popover — save the edited video as a new file beside the original */
	previewVideoSaveAsCopy: "Save as copy",
	/** Save popover — the save copies the kept parts without re-encoding (fast, no quality loss) */
	previewVideoSaveFast: "Fast – no re-encode",
	/** Save popover — the save decodes and encodes the video again */
	previewVideoSaveReencode: "Re-encode",
	/** Save popover — what the fast save means */
	previewVideoSaveFastHint: "Only cuts: picture and sound are copied as they are.",
	/** Save popover — why the save re-encodes */
	previewVideoSaveReencodeHint: "Your changes to the picture, sound or timing need a re-encode.",
	/** Save popover — the expected file size and save time; {{size}} like "120 MB", {{time}} like "about 3 min" */
	previewVideoSaveEstimate: "≈ {{size}} · {{time}}",
	/** Save popover / progress — the save is expected to take less than a minute */
	previewVideoSaveUnderMinute: "under a minute",
	/** Save popover / progress — the save is expected to take about this many minutes */
	previewVideoSaveMinutes_one: "about {{count}} min",
	/** Save popover / progress — the save is expected to take about this many minutes */
	previewVideoSaveMinutes_other: "about {{count}} min",
	/** Save popover — the saved video's length; {{length}} is a timecode */
	previewVideoSaveLength: "Length {{length}}",
	/** Save popover — what the save leaves out */
	previewVideoSaveDropSubtitlesAndChapters: "Subtitles and chapters removed",
	/** Save popover — what the save leaves out */
	previewVideoSaveDropSubtitles: "Subtitles removed",
	/** Save popover — what the save leaves out */
	previewVideoSaveDropChapters: "Chapters removed",
	/** Save popover — what the save leaves out */
	previewVideoSaveDropExtraAudio: "Extra audio tracks removed",
	/** Save popover — what the save leaves out */
	previewVideoSaveDropHdrMetadata: "HDR details removed",
	/** Save popover — what the save leaves out */
	previewVideoSaveDropLocation: "Location removed",
	/** Save popover — the HDR video is saved as a standard-range video */
	previewVideoSaveHdrToSdr: "HDR will be converted to SDR",
	/** Save popover — saving in place keeps the original as an older version */
	previewVideoSaveVersionKept: "Previous version kept in Versions",
	/** Save popover — this drive keeps no versions: saving in place replaces the original for good */
	previewVideoSaveVersioningOff: "Versions are off: Save replaces the original for good.",
	/** Save popover — this format is only saved as a new file beside the original */
	previewVideoSaveCopyOnly: "Saved as a new MP4 file beside the original.",
	/** Save popover — the saved video's picture size */
	previewVideoSaveResolution: "Resolution",
	/** Save popover — keep the picture size */
	previewVideoSaveResolutionOriginal: "Original",
	/** Save popover — the saved video's quality (bigger or smaller file) */
	previewVideoSaveQuality: "Quality",
	/** Save popover — quality option */
	previewVideoSaveQualityHigh: "High",
	/** Save popover — quality option */
	previewVideoSaveQualityMedium: "Medium",
	/** Save popover — quality option */
	previewVideoSaveQualityLow: "Low",
	/** Save popover — switch: leave the recording location out of the saved video */
	previewVideoSaveRemoveLocation: "Remove location",
	/** Save popover — the summary is still being worked out */
	previewVideoSavePlanning: "Working out the save…",
	/** Export progress — percent done; {{percent}} is a whole number */
	previewVideoSaveExporting: "Exporting… {{percent}}%",
	/** Export progress — keep exporting as a transfer and close the editor */
	previewVideoSaveContinueInBackground: "Continue in background",
	/** Export progress — stop the export (nothing is saved) */
	previewVideoSaveCancelExport: "Cancel",
	/** Export progress — accessible name of the Cancel button (its visible text is "Cancel") */
	previewVideoSaveCancelExportLabel: "Cancel export",
	/** Export progress — the export failed; the edits are kept */
	previewVideoSaveFailed: "The video couldn't be saved.",
	/** Export progress — try the failed export again with the same edits */
	previewVideoSaveRetry: "Retry",
	/** Export progress — close the failure notice and go on editing */
	previewVideoSaveDismiss: "Dismiss",
	/** Toast — the edited video was saved; {{name}} is the file name */
	previewVideoSaveDone: "Saved {{name}}",
	/** Toast — the edited video was saved as a copy; {{name}} is the file name of the original */
	previewVideoSaveDoneCopy: "Saved a copy of {{name}}",
	/** Toast — an export running in the background failed; {{name}} is the file name */
	previewVideoSaveBackgroundFailed: "{{name}} couldn't be saved."
} as const
