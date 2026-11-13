// "preview" namespace, video editor — the keyboard shortcuts list's names for its keys. Spread into preview.ts; same
// catalog rules.
export const previewVideoEditKeys = {
	/** Keyboard shortcuts list (video editor) — undo the last edit */
	previewVideoEditKeyUndo: "Undo the last video edit",
	/** Keyboard shortcuts list (video editor) — redo the edit just undone */
	previewVideoEditKeyRedo: "Redo the video edit",
	/** Keyboard shortcuts list (video editor) — save the edited video as a new file beside the original */
	previewVideoEditKeySaveCopy: "Save the video as a copy",
	/** Keyboard shortcuts list (video editor) — leave the editor without saving (asks first over unsaved edits) */
	previewVideoEditKeyCancel: "Leave the video editor",
	/** Keyboard shortcuts list (video editor) — start or stop playback */
	previewVideoEditKeyPlayPause: "Play or pause",
	/** Keyboard shortcuts list (video editor) — the J of J/K/L: go back one second */
	previewVideoEditKeyShuttleBack: "Back one second",
	/** Keyboard shortcuts list (video editor) — the K of J/K/L: stop playback */
	previewVideoEditKeyShuttlePause: "Pause",
	/** Keyboard shortcuts list (video editor) — the L of J/K/L: play, faster with each press */
	previewVideoEditKeyShuttleForward: "Play, faster with each press",
	/** Keyboard shortcuts list (video editor) — move the playhead one frame back */
	previewVideoEditKeyFrameBack: "Previous frame",
	/** Keyboard shortcuts list (video editor) — move the playhead one frame forward */
	previewVideoEditKeyFrameForward: "Next frame",
	/** Keyboard shortcuts list (video editor) — move the playhead one second back */
	previewVideoEditKeySecondBack: "Back one second",
	/** Keyboard shortcuts list (video editor) — move the playhead one second forward */
	previewVideoEditKeySecondForward: "Forward one second",
	/** Keyboard shortcuts list (video editor) — move the playhead to the start of the video */
	previewVideoEditKeyToStart: "Go to the start",
	/** Keyboard shortcuts list (video editor) — move the playhead to the end of the video */
	previewVideoEditKeyToEnd: "Go to the end",
	/** Keyboard shortcuts list (video editor) — start the selection at the playhead */
	previewVideoEditKeySetIn: "Set the selection's start",
	/** Keyboard shortcuts list (video editor) — end the selection at the playhead */
	previewVideoEditKeySetOut: "Set the selection's end",
	/** Keyboard shortcuts list (video editor) — split the timeline at the playhead (to select a part) */
	previewVideoEditKeySplit: "Split at the playhead",
	/** Keyboard shortcuts list (video editor) — cut the selected section out of the video */
	previewVideoEditKeyRemoveSection: "Remove the selected section",
	/** Keyboard shortcuts list (video editor) — play the selection over and over */
	previewVideoEditKeyLoop: "Loop the selection",
	/** Keyboard shortcuts list (video editor) — zoom the timeline in */
	previewVideoEditKeyZoomIn: "Zoom the timeline in",
	/** Keyboard shortcuts list (video editor) — zoom the timeline out */
	previewVideoEditKeyZoomOut: "Zoom the timeline out",
	/** Keyboard shortcuts list (video editor) — show the whole video on the timeline */
	previewVideoEditKeyZoomFit: "Fit the timeline",
	/** Keyboard shortcuts list (video editor) — save the frame on screen as a picture */
	previewVideoEditKeySaveFrame: "Save the frame as an image"
} as const
