// "preview" namespace, presentation slide show: the Slide Show tab, Set Up Slide Show, and what the running show says
// (animation triggers, links, notices). Spread into preview.ts; same catalog rules.
export const previewPptxShow = {
	/** Presentation editor, Slide Show tab — group of the commands that start the slide show */
	previewPptxShowStartGroup: "Start slide show",
	/** Presentation editor, Slide Show tab — starts the slide show from the first slide */
	previewPptxShowFromBeginning: "From Beginning",
	/** Presentation editor, Slide Show tab — starts the slide show from the slide in view */
	previewPptxShowFromCurrent: "From Current Slide",
	/** Presentation editor, Slide Show tab — menu of the presentation's custom shows (named subsets of its slides) */
	previewPptxShowCustom: "Custom slide show",
	/** Presentation editor, Slide Show tab — the custom show menu when the presentation has none */
	previewPptxShowCustomNone: "This presentation has no custom shows.",
	/** Presentation editor, Slide Show tab — starts the slide show with the speaker's own view (notes, next slide, timer) */
	previewPptxShowPresenterView: "Presenter View",
	/** Presentation editor, Slide Show tab — group of the slide show settings */
	previewPptxShowSetUpGroup: "Set Up",
	/** Presentation editor, Slide Show tab — opens the slide show settings */
	previewPptxShowSetUp: "Set up slide show",

	/** Set Up Slide Show dialog — title */
	previewPptxShowSetUpTitle: "Set up slide show",
	/** Set Up Slide Show dialog — what the settings apply to */
	previewPptxShowSetUpDescription: "These settings apply to the slide shows you start until you close the presentation.",
	/** Set Up Slide Show dialog — what the settings apply to, in a presentation they are saved in */
	previewPptxShowSetUpDescriptionSaved: "These settings are saved with the presentation and used by every slide show.",
	/** Set Up Slide Show dialog — under the show type in an OpenDocument presentation, why kiosk is not offered */
	previewPptxShowOdfNoKiosk: "OpenDocument presentations can't be saved as kiosk shows.",
	/** Set Up Slide Show dialog — under the slide range in an OpenDocument presentation */
	previewPptxShowOdfRangeToEnd: "In OpenDocument presentations the show runs from this slide to the last.",
	/** Set Up Slide Show dialog — group label: who runs the show */
	previewPptxShowType: "Show type",
	/** Set Up Slide Show dialog — show type: a speaker moves through the slides */
	previewPptxShowTypeSpeaker: "Presented by a speaker",
	/** Set Up Slide Show dialog — show type: runs on its own; clicks do not advance, it loops and restarts */
	previewPptxShowTypeKiosk: "Browsed at a kiosk",
	/** Set Up Slide Show dialog — switch: start over after the last slide until Esc is pressed */
	previewPptxShowLoop: "Loop continuously until Esc",
	/** Set Up Slide Show dialog — group label: which slides the show runs through */
	previewPptxShowSlides: "Show slides",
	/** Set Up Slide Show dialog — show slides: every slide that is not hidden */
	previewPptxShowSlidesAll: "All",
	/** Set Up Slide Show dialog — show slides: a range of slide numbers */
	previewPptxShowSlidesRange: "From slide to slide",
	/** Set Up Slide Show dialog — the first slide number of the range */
	previewPptxShowSlidesFrom: "From",
	/** Set Up Slide Show dialog — the last slide number of the range */
	previewPptxShowSlidesTo: "To",
	/** Set Up Slide Show dialog — error under the slide range: the numbers must be slides of the presentation, the first not after the last */
	previewPptxShowSlidesRangeInvalid: "Enter slide numbers from 1 to {{count}}, the first not after the last.",
	/** Set Up Slide Show dialog — show slides: one of the presentation's custom shows */
	previewPptxShowSlidesCustom: "Custom show",
	/** Set Up Slide Show dialog — group label: how the show moves to the next slide */
	previewPptxShowAdvance: "Advance slides",
	/** Set Up Slide Show dialog — advance slides: only on a click or key */
	previewPptxShowAdvanceManual: "Manually",
	/** Set Up Slide Show dialog — advance slides: after each slide's own timing, where it has one */
	previewPptxShowAdvanceTimings: "Using timings, if present",
	/** Set Up Slide Show dialog — confirm button */
	previewPptxShowSetUpApply: "Apply",

	/** Slide show — accessible name of a shape that plays an animation when clicked; {{name}} is the shape's name or description */
	previewPptxShowTrigger: "Play animation: {{name}}",
	/** Slide show — accessible name of a shape that plays an animation when clicked, when it has no name */
	previewPptxShowTriggerUnnamed: "Play animation",
	/** Slide show — accessible name of a link in the slide's text; {{target}} is its web address or tooltip */
	previewPptxShowLink: "Link: {{target}}",
	/** Slide show — note while a slide plays: its animations exceed what can be played, so it shows without them */
	previewPptxShowTimingTooLarge: "This slide's animations are too complex to play. It is shown without them.",
	/** Slide show — note while a slide plays: a text size animation is shown by scaling the text, so lines may look different than in PowerPoint */
	previewPptxShowFontScaled: "A text size animation on this slide is shown by scaling the text."
}
