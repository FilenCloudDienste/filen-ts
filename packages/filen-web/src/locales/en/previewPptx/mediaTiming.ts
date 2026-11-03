// "preview" namespace, presentations: a video's or audio clip's trim, fade and bookmarks (the Video and Audio tabs'
// Editing and Bookmarks groups), the animation trigger a bookmark is, and what a copy without them reports. Spread
// into preview.ts; same catalog rules.
export const previewPptxMediaTiming = {
	/** Presentation editor — Video/Audio tab group holding Trim and Fade */
	previewPptxMediaEditingGroup: "Editing",
	/** Presentation editor — Video/Audio tab button: opens the dialog setting how much of the clip is cut from its start and end */
	previewPptxMediaTrim: "Trim",
	/** Presentation editor — the Trim dialog's explanation */
	previewPptxMediaTrimDescription: "How much is cut from the start and from the end when it plays.",
	/** Presentation editor — Trim dialog field: seconds cut from the clip's start */
	previewPptxMediaTrimStart: "Cut from the start (seconds)",
	/** Presentation editor — Trim dialog field: seconds cut from the clip's end */
	previewPptxMediaTrimEnd: "Cut from the end (seconds)",
	/** Presentation editor — the Trim dialog's explanation when the clip's length is known; time is that length in seconds */
	previewPptxMediaTrimTimesDescription:
		"The part of the clip that plays, from its start time to its end time. The clip is {{time}} s long.",
	/** Presentation editor — Trim dialog field: the time in the clip where playing starts */
	previewPptxMediaTrimStartTime: "Start time (seconds)",
	/** Presentation editor — Trim dialog field: the time in the clip where playing ends */
	previewPptxMediaTrimEndTime: "End time (seconds)",
	/** Presentation editor — Trim dialog: a time past the clip's end; time is its length in seconds */
	previewPptxMediaTrimBeyond: "Enter a time within the clip's {{time}} s",
	/** Presentation editor — Trim dialog: the end time is not after the start time */
	previewPptxMediaTrimOrder: "The end time must come after the start time",
	/** Presentation editor — Trim dialog while the clip's length is being read */
	previewPptxMediaTrimReading: "Reading the clip's length…",
	/** Presentation editor — Trim dialog when the clip's length couldn't be read: it asks for the cuts instead */
	previewPptxMediaTrimNoLength: "The clip's length couldn't be read, so enter how much to cut from each end.",
	/** Presentation editor — Video/Audio tab button: opens the dialog setting the clip's fade in and fade out */
	previewPptxMediaFade: "Fade",
	/** Presentation editor — the Fade dialog's explanation */
	previewPptxMediaFadeDescription: "How long the sound fades in as it starts and out before it ends.",
	/** Presentation editor — Fade dialog field: seconds the clip's sound takes to fade in */
	previewPptxMediaFadeIn: "Fade in (seconds)",
	/** Presentation editor — Fade dialog field: seconds the clip's sound takes to fade out */
	previewPptxMediaFadeOut: "Fade out (seconds)",
	/** Presentation editor — Trim, Fade and Add bookmark dialogs: a time field outside its range */
	previewPptxMediaSecondsRange: "Enter seconds from 0 to {{max}}",
	/** Presentation editor — Video/Audio tab group holding the clip's bookmarks */
	previewPptxMediaBookmarksGroup: "Bookmarks",
	/** Presentation editor — Video/Audio tab button: opens the dialog adding a named point in time to the clip */
	previewPptxMediaAddBookmark: "Add bookmark",
	/** Presentation editor — the Add bookmark dialog's explanation */
	previewPptxMediaAddBookmarkDescription: "A named point in the clip. Reaching it while the clip plays can start an animation.",
	/** Presentation editor — Add bookmark dialog field: the bookmark's name */
	previewPptxMediaBookmarkName: "Name",
	/** Presentation editor — Add bookmark dialog field: seconds from the clip's start */
	previewPptxMediaBookmarkTime: "Time from the start (seconds)",
	/** Presentation editor — the name the Add bookmark dialog suggests; count is the bookmark's number */
	previewPptxMediaBookmarkDefault: "Bookmark {{count}}",
	/** Presentation editor — Add bookmark dialog: another bookmark of the clip has this name */
	previewPptxMediaBookmarkNameTaken: "Another bookmark has this name",
	/** Presentation editor — Add bookmark dialog: another bookmark of the clip is at this time */
	previewPptxMediaBookmarkTimeTaken: "Another bookmark is at this time",
	/** Presentation editor — Video/Audio tab menu: removes one of the clip's bookmarks */
	previewPptxMediaRemoveBookmark: "Remove bookmark",
	/** Presentation editor — Remove bookmark menu item: a bookmark's name and its time in seconds */
	previewPptxMediaBookmarkItem: "{{name}} ({{time}} s)",
	/** Presentation editor — Remove bookmark menu, when the clip has no bookmarks */
	previewPptxMediaNoBookmarks: "No bookmarks",
	/** Presentation editor — Remove bookmark menu: why a bookmark's item is off (an animation starts on it) */
	previewPptxMediaBookmarkUsed: "Used by an animation's trigger. Change the trigger first.",
	/** Presentation editor — Add bookmark dialog: the name is empty, has control characters or is too long */
	previewPptxMediaBookmarkNameInvalid: "Enter a name of up to 255 characters",
	/** Presentation editor — Add bookmark dialog: the clip already has the most bookmarks it can hold */
	previewPptxMediaBookmarksFull: "This clip already has {{max}} bookmarks, the most it can hold",
	/** Presentation editor — why the Trim, Fade and bookmark buttons are off in a presentation that is not a PowerPoint (.pptx) file */
	previewPptxMediaUnavailableFormat: "Trim, fade and bookmarks can only be set in PowerPoint (.pptx) presentations",
	/** Presentation editor — the Trim dialog's explanation while the clip's length is read */
	previewPptxMediaTrimNeutral: "The part of the clip that plays.",
	/** Presentation editor — a shape's name in a list where another shape has the same name; index tells them apart */
	previewPptxAnimShapeNumbered: "{{name}} ({{index}})",
	/** Presentation editor — Animations ▸ Trigger menu heading: the bookmarks of the slide's clips */
	previewPptxAnimTriggerBookmarks: "On Bookmark",
	/** Presentation editor — Animations ▸ Trigger menu item: start the effect when a clip reaches a bookmark */
	previewPptxAnimTriggerBookmark: "{{bookmark}} of {{name}}",
	/** Converted copy — kept differently: a clip's trim, fade or bookmark, which the copy's format has no form for */
	previewPptxConvertLossMediaTiming_one: "{{count}} clip trim, fade or bookmark, left out",
	/** Converted copy — as previewPptxConvertLossMediaTiming_one, for several */
	previewPptxConvertLossMediaTiming_other: "{{count}} clip trims, fades or bookmarks, left out",
	/** Converted copy — kept differently: an animation a clip's bookmark starts, which the copy starts on a click of the clip instead (it has no bookmarks) */
	previewPptxConvertLossBookmarkTrigger_one: "{{count}} animation triggered by a bookmark, started on click instead",
	/** Converted copy — as previewPptxConvertLossBookmarkTrigger_one, for several */
	previewPptxConvertLossBookmarkTrigger_other: "{{count}} animations triggered by a bookmark, started on click instead"
} as const
