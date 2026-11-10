// "preview" namespace, presentation slideshow: the presenter view (its window, current and next slide, notes, timer,
// controls), starting full screen, and the show's keyboard shortcuts. Spread into preview.ts; same catalog rules.
export const previewPptxPresenter = {
	/** Presentation slideshow — title of the separate browser window that shows the presenter view */
	previewPptxPresenterWindowTitle: "Presenter view",
	/** Presentation slideshow — accessible name of the presenter view (current slide, next slide, notes, timer) */
	previewPptxPresenterLabel: "Presenter view",
	/** Presentation slideshow — accessible name of the current slide in the presenter view */
	previewPptxPresenterCurrent: "Current slide",
	/** Presentation slideshow — heading over the preview of the slide that comes next */
	previewPptxPresenterNext: "Next slide",
	/** Presentation slideshow — shown instead of the next slide when the next click plays an animation on this slide */
	previewPptxPresenterNextStep: "Next animation on this slide",
	/** Presentation slideshow — shown instead of the next slide after the last one */
	previewPptxPresenterEndOfShow: "End of slide show",
	/** Presentation slideshow — heading of the speaker notes in the presenter view */
	previewPptxPresenterNotes: "Notes",
	/** Presenter view — accessible name of the speaker notes area (unique beside the editor's own notes pane) */
	previewPptxPresenterNotesRegion: "Speaker notes",
	/** Presentation slideshow — shown when the current slide has no speaker notes */
	previewPptxPresenterNoNotes: "No notes for this slide",
	/** Presentation slideshow — button that makes the notes text larger */
	previewPptxPresenterNotesLarger: "Larger notes text",
	/** Presentation slideshow — button that makes the notes text smaller */
	previewPptxPresenterNotesSmaller: "Smaller notes text",
	/** Presentation slideshow — accessible name of the timer showing how long the presentation has been running */
	previewPptxPresenterTimer: "Time presenting",
	/** Presentation slideshow — button that pauses the presentation timer */
	previewPptxPresenterPause: "Pause timer",
	/** Presentation slideshow — button that resumes the paused presentation timer */
	previewPptxPresenterResume: "Resume timer",
	/** Presentation slideshow — button that sets the presentation timer back to zero */
	previewPptxPresenterResetTimer: "Restart timer",
	/** Presentation slideshow — accessible name of the time of day shown in the presenter view */
	previewPptxPresenterClock: "Current time",
	/** Presentation slideshow — where the show is, e.g. "Slide 3 of 12" */
	previewPptxPresenterSlideCount: "Slide {{current}} of {{total}}",
	/** Presentation slideshow — button: previous slide or animation */
	previewPptxPresenterPrevious: "Previous",
	/** Presentation slideshow — button: next slide or animation */
	previewPptxPresenterNextButton: "Next",
	/** Presentation slideshow — button that blacks out the audience's screen (again to return) */
	previewPptxPresenterBlack: "Black screen",
	/** Presentation slideshow — button that whites out the audience's screen (again to return) */
	previewPptxPresenterWhite: "White screen",
	/** Presentation slideshow — button that ends the slideshow */
	previewPptxPresenterEnd: "End slide show",
	/** Presentation slideshow — button in the slideshow window that shows it full screen, after the presenter view opened in its own window */
	previewPptxPresenterStart: "Start slide show",
	/** Presentation slideshow — note in the presenter view when the browser would not show the slideshow full screen from there */
	previewPptxPresenterStartHint: "Click Start slide show in the slide show window to show it full screen.",
	/** Presentation slideshow — note when the browser blocked the presenter view's own window, so it is shown in this one */
	previewPptxPresenterBlocked: "Your browser blocked the presenter window, so the presenter view is shown here.",
	/** Presentation slideshow — button in the presenter view (shown in the same window) that shows the slideshow instead */
	previewPptxPresenterShowAudience: "Show slide show",
	/** Presentation slideshow — button over the slideshow that brings the presenter view back */
	previewPptxPresenterShowPresenter: "Show presenter view",
	/** Presentation slideshow — button that starts the slideshow with the presenter view */
	previewPptxPresenterOpen: "Presenter view",
	/** Presentation shortcuts — next slide or animation in a slideshow */
	previewPptxShortcutShowNext: "Slide show: next slide or animation",
	/** Presentation shortcuts — previous slide or animation in a slideshow */
	previewPptxShortcutShowPrevious: "Slide show: previous slide or animation",
	/** Presentation shortcuts — first slide of a slideshow */
	previewPptxShortcutShowFirst: "Slide show: first slide",
	/** Presentation shortcuts — last slide of a slideshow */
	previewPptxShortcutShowLast: "Slide show: last slide",
	/** Presentation shortcuts — show the next slide in a slideshow when it is a hidden slide */
	previewPptxShortcutShowNextHidden: "Slide show: next slide if it is hidden",
	/** Presentation shortcuts — black screen in a slideshow */
	previewPptxShortcutShowBlack: "Slide show: black screen",
	/** Presentation shortcuts — white screen in a slideshow */
	previewPptxShortcutShowWhite: "Slide show: white screen",
	/** Presentation shortcuts — end a slideshow (or put down the pen first) */
	previewPptxShortcutShowEnd: "Slide show: end",
	/** Presentation shortcuts — turn the laser pointer on or off in a slideshow */
	previewPptxShortcutShowLaser: "Slide show: laser pointer",
	/** Presentation shortcuts — turn the pen on or off in a slideshow */
	previewPptxShortcutShowPen: "Slide show: pen",
	/** Presentation shortcuts — turn the eraser on or off in a slideshow */
	previewPptxShortcutShowEraser: "Slide show: eraser",
	/** Presentation shortcuts — back to the normal pointer (no pen) in a slideshow */
	previewPptxShortcutShowArrow: "Slide show: arrow pointer",
	/** Presentation shortcuts — hide the mouse pointer in a slideshow until it is shown again */
	previewPptxShortcutShowHidePointer: "Slide show: hide the pointer",
	/** Presentation shortcuts — hide the mouse pointer, or keep it always shown, in a slideshow */
	previewPptxShortcutShowTogglePointer: "Slide show: show or hide the pointer",
	/** Presentation shortcuts — erase all ink on the current slide in a slideshow */
	previewPptxShortcutShowEraseAll: "Slide show: erase all ink on the slide",
	/** Presentation shortcuts — start the slideshow from the first slide */
	previewPptxShortcutShowStart: "Start slide show from the beginning",
	/** Presentation shortcuts — start the slideshow from the current slide */
	previewPptxShortcutShowStartCurrent: "Start slide show from the current slide",
	/** Presentation shortcuts — turn the highlighter on or off in a slideshow */
	previewPptxShortcutShowHighlighter: "Slide show: highlighter",
	/** Presentation shortcuts — start the slideshow in the presenter view, from the current slide */
	previewPptxShortcutShowPresenterView: "Start slide show in Presenter View"
}
