// "preview" namespace, video editor — the editing surface: the stage, the timeline and the tools panel (Trim, Crop,
// Adjust, Audio, Speed, Text). Spread into preview.ts; same catalog rules. The colour sliders and filters reuse the
// image editor's names.
export const previewVideoEditor = {
	/** Video preview header — button that opens the video in the editor */
	previewVideoEditOpen: "Edit video",
	/** Video preview — the video cannot be opened in the editor (no picture this browser can show, or an unreadable file) */
	previewVideoEditUnavailable: "This video can't be edited in this browser.",
	/** Video editor — accessible name of the edited video (the stage showing the result) */
	previewVideoEditStage: "Edited video",
	/** Video editor — accessible name of the panel holding the editing tools */
	previewVideoEditTools: "Editing tools",
	/** Video editor — panel tab: trimming the ends and cutting sections out */
	previewVideoEditTabTrim: "Trim",
	/** Video editor — panel tab: cropping, rotating and flipping the picture */
	previewVideoEditTabCrop: "Crop",
	/** Video editor — panel tab: colour sliders and filters */
	previewVideoEditTabAdjust: "Adjust",
	/** Video editor — panel tab: mute, volume and audio tracks */
	previewVideoEditTabAudio: "Audio",
	/** Video editor — panel tab: playback speed of the saved video */
	previewVideoEditTabSpeed: "Speed",
	/** Video editor — panel tab: text shown over the video */
	previewVideoEditTabText: "Text",
	/** Video editor — a tool this browser cannot apply to a saved video (it has no video encoder for it) */
	previewVideoEditFeatureUnavailable: "Not available in this browser",
	/** Video editor — note under the stage: colour, crop and text show exactly only on a paused frame */
	previewVideoEditPausedPreviewHint: "Colour and text show exactly while paused.",

	// ── Transport and timeline ───────────────────────────────────────────────
	/** Video editor — start playback */
	previewVideoEditPlay: "Play",
	/** Video editor — stop playback */
	previewVideoEditPause: "Pause",
	/** Video editor — move one frame back */
	previewVideoEditFrameBack: "Previous frame",
	/** Video editor — move one frame forward */
	previewVideoEditFrameForward: "Next frame",
	/** Video editor — toggle: play the selection over and over */
	previewVideoEditLoop: "Loop selection",
	/** Video editor — zoom the timeline in */
	previewVideoEditZoomIn: "Zoom in",
	/** Video editor — zoom the timeline out */
	previewVideoEditZoomOut: "Zoom out",
	/** Video editor — show the whole video on the timeline */
	previewVideoEditZoomFit: "Fit timeline",
	/** Video editor — undo the last edit */
	previewVideoEditUndo: "Undo",
	/** Video editor — redo the edit just undone */
	previewVideoEditRedo: "Redo",
	/** Video editor — accessible name of the timeline (filmstrip, waveform, trim handles) */
	previewVideoEditTimeline: "Timeline",
	/** Video editor — accessible name of the playhead position read-out ("00:12.40 of 01:45.00") */
	previewVideoEditPosition: "Position",
	/** Video editor — trim handle at the start of a kept part of the video; {{number}} counts the parts from 1 */
	previewVideoEditHandleStart: "Start of part {{number}}",
	/** Video editor — trim handle at the end of a kept part of the video; {{number}} counts the parts from 1 */
	previewVideoEditHandleEnd: "End of part {{number}}",
	/** Video editor — a section cut out of the video on the timeline: {{start}} and {{end}} are timecodes */
	previewVideoEditRemovedRange: "Removed {{start}} to {{end}}",
	/** Video editor — where a cut really lands on a fast save: the edge moves later to a key frame by {{seconds}} seconds */
	previewVideoEditSnapsLater: "Snaps {{seconds}} s later",
	/** Video editor — where a cut really lands on a fast save: the edge moves earlier to a key frame by {{seconds}} seconds */
	previewVideoEditSnapsEarlier: "Snaps {{seconds}} s earlier",
	/** Video editor — button beside a snapping note: cut exactly where set (the save re-encodes) */
	previewVideoEditMakePrecise: "Make precise",
	/** Video editor — the selection on the timeline: {{start}} and {{end}} are timecodes */
	previewVideoEditSelectionRange: "Selected {{start}} to {{end}}",
	/** Video editor — split the timeline at the playhead, so a part can be clicked and removed */
	previewVideoEditSplit: "Split at playhead",
	/** Video editor — cut the selected section out of the video */
	previewVideoEditRemoveSection: "Remove section",
	/** Video editor — save the frame on screen as a picture next to the video */
	previewVideoEditSaveFrame: "Save frame as image",
	/** Video editor — the frame was saved as a picture; {{name}} is its file name */
	previewVideoEditFrameSaved: "Saved {{name}}",
	/** Video editor — saving the frame as a picture failed */
	previewVideoEditFrameFailed: "The frame couldn't be saved.",
	/** Video editor — the video could not be prepared for editing */
	previewVideoEditLoadFailed: "This video couldn't be opened for editing.",

	// ── Trim ─────────────────────────────────────────────────────────────────
	/** Video editor, Trim tab — the trimmed video's first moment */
	previewVideoEditStart: "Start",
	/** Video editor, Trim tab — the trimmed video's last moment */
	previewVideoEditEnd: "End",
	/** Video editor, Trim tab — a typed time that is not one; shows the expected shape */
	previewVideoEditTimecodeInvalid: "Type a time like 01:05.25",
	/** Video editor, Trim tab — the saved video's length after cuts and speed */
	previewVideoEditOutputLength: "Length after edits",
	/** Video editor, Trim tab — the selection's own start and end */
	previewVideoEditSelection: "Selection",
	/** Video editor, Trim tab — start of the selection */
	previewVideoEditSelectionIn: "In",
	/** Video editor, Trim tab — end of the selection */
	previewVideoEditSelectionOut: "Out",
	/** Video editor, Trim tab — explains how to select: drag on the timeline, mark with I and O, or click a part after splitting */
	previewVideoEditSelectionHint: "Drag across the timeline, or mark the start and end with I and O, to select a section.",
	/** Video editor, Trim tab — forget the selection */
	previewVideoEditClearSelection: "Clear selection",
	/** Video editor, Trim tab — the list of sections cut out of the video */
	previewVideoEditRemovedSections: "Removed sections",
	/** Video editor, Trim tab — put a removed section back */
	previewVideoEditRestoreSection: "Restore",
	/** Video editor, Trim tab — accessible name of a removed section's restore button: {{start}} and {{end}} are timecodes */
	previewVideoEditRestoreSectionLabel: "Restore {{start}} to {{end}}",
	/** Video editor, Trim tab — nothing has been cut out yet */
	previewVideoEditNoRemovedSections: "Nothing removed yet.",
	/** Video editor, Trim tab — switch: cut exactly where set instead of at the nearest key frame */
	previewVideoEditPrecise: "Precise cuts",
	/** Video editor, Trim tab — what precise cuts cost */
	previewVideoEditPreciseHint: "Cuts exactly where you set them. Saving then re-encodes the video, which takes longer.",

	// ── Crop ─────────────────────────────────────────────────────────────────
	/** Video editor, Crop tab — the shape of the crop */
	previewVideoEditAspect: "Aspect ratio",
	/** Video editor, Crop tab — rotate the picture a quarter turn left */
	previewVideoEditRotateLeft: "Rotate left",
	/** Video editor, Crop tab — rotate the picture a quarter turn right */
	previewVideoEditRotateRight: "Rotate right",
	/** Video editor, Crop tab — mirror the picture left to right */
	previewVideoEditFlipHorizontal: "Flip horizontal",
	/** Video editor, Crop tab — mirror the picture top to bottom */
	previewVideoEditFlipVertical: "Flip vertical",
	/** Video editor, Crop tab — undo the crop, rotation and flips */
	previewVideoEditResetCrop: "Reset",
	/** Video editor, Crop tab — the cropped picture's size in pixels */
	previewVideoEditCropSize: "{{width}} × {{height}}",

	// ── Adjust ───────────────────────────────────────────────────────────────
	/** Video editor, Adjust tab — colour changes are off for this HDR video in this browser */
	previewVideoEditAdjustHdr: "Colour changes save this HDR video as SDR.",
	/** Video editor, Adjust tab — the filters' heading */
	previewVideoEditFilters: "Filters",

	// ── Audio ────────────────────────────────────────────────────────────────
	/** Video editor, Audio tab — switch: save the video without sound */
	previewVideoEditMute: "Mute",
	/** Video editor, Audio tab — the sound's volume change */
	previewVideoEditGain: "Volume",
	/** Video editor, Audio tab — a volume change in decibels; {{gain}} is signed, e.g. "+3.0" */
	previewVideoEditGainValue: "{{gain}} dB",
	/** Video editor, Audio tab — a boost previews at full volume (a browser cannot play louder than the file) */
	previewVideoEditGainHint: "A boost plays at full volume here; the saved video is louder.",
	/** Video editor, Audio tab — the source's audio tracks to keep */
	previewVideoEditTracks: "Audio tracks",
	/** Video editor, Audio tab — one audio track; {{number}} counts from 1 */
	previewVideoEditTrack: "Track {{number}}",
	/** Video editor, Audio tab — one audio track with its language; {{number}} counts from 1 */
	previewVideoEditTrackLanguage: "Track {{number}} · {{language}}",
	/** Video editor, Audio tab — the video has no sound */
	previewVideoEditNoAudio: "This video has no sound.",

	// ── Speed ────────────────────────────────────────────────────────────────
	/** Video editor, Speed tab — the saved video's speed */
	previewVideoEditSpeed: "Speed",
	/** Video editor, Speed tab — a speed; {{speed}} is a number like 1.5 */
	previewVideoEditSpeedValue: "{{speed}}×",
	/** Video editor, Speed tab — sound keeps its pitch at any speed */
	previewVideoEditSpeedHint: "The sound keeps its pitch.",

	// ── Text ─────────────────────────────────────────────────────────────────
	/** Video editor, Text tab — add a new text box over the video */
	previewVideoEditAddText: "Add text",
	/** Video editor, Text tab — what a new text box says until it is typed over */
	previewVideoEditTextDefault: "Text",
	/** Video editor, Text tab — the text field of the selected box */
	previewVideoEditTextField: "Text",
	/** Video editor, Text tab — the text's size */
	previewVideoEditTextSize: "Size",
	/** Video editor, Text tab — the text's colour */
	previewVideoEditTextColor: "Colour",
	/** Video editor, Text tab — switch: a dark rounded background behind the text */
	previewVideoEditTextBackground: "Background",
	/** Video editor, Text tab — when the text shows, from */
	previewVideoEditTextFrom: "Shows from",
	/** Video editor, Text tab — when the text shows, until */
	previewVideoEditTextTo: "Until",
	/** Video editor, Text tab — show the text exactly while the timeline selection plays */
	previewVideoEditTextUseSelection: "Show during selection",
	/** Video editor, Text tab — remove the selected text box */
	previewVideoEditTextDelete: "Delete text",
	/** Video editor, Text tab — no text boxes yet */
	previewVideoEditNoText: "No text yet.",
	/** Video editor, Text tab — how to place text */
	previewVideoEditTextHint: "Drag text on the video to move it. Times are on the edited video.",
	/** Video editor, stage — accessible name of a text box over the video; {{text}} is what it says */
	previewVideoEditTextBox: "Text: {{text}}",
	/** Video editor, Text tab — colour swatch names */
	previewVideoEditColorWhite: "White",
	/** Video editor, Text tab — colour swatch names */
	previewVideoEditColorBlack: "Black",
	/** Video editor, Text tab — colour swatch names */
	previewVideoEditColorYellow: "Yellow",
	/** Video editor, Text tab — colour swatch names */
	previewVideoEditColorRed: "Red",
	/** Video editor, Text tab — colour swatch names */
	previewVideoEditColorBlue: "Blue"
} as const
