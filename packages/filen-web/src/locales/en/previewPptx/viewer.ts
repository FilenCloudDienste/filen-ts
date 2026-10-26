// "preview" namespace, presentation viewer: the slide canvas, the slide rail, the notes pane, the slide show and what
// the viewer says when a deck can't be shown or edited. Spread into preview.ts; same catalog rules.
export const previewPptxViewer = {
	/** Presentation viewer — accessible name of the command bar */
	previewPptxCommandBar: "Presentation",
	/** Presentation viewer — accessible name of the slide in view, e.g. "Slide 3 of 12" */
	previewPptxSlideLabel: "Slide {{current}} of {{total}}",
	/** Presentation viewer — shown on the stage when the presentation has no slides at all */
	previewPptxEmptyDeck: "This presentation has no slides.",
	/** Presentation viewer — accessible name of a slide in the slide list that is hidden in the slide show, e.g. "Slide 3 of 12, hidden" */
	previewPptxSlideHiddenLabel: "Slide {{current}} of {{total}}, hidden",
	/** Presentation viewer — accessible name of the list of slide thumbnails */
	previewPptxRailLabel: "Slides",
	/** Presentation viewer — command bar group of the slide controls (previous, the slide number, next) */
	previewPptxSlidesGroup: "Slides",
	/** Presentation viewer — accessible name of the speaker notes pane under the slide */
	previewPptxNotesLabel: "Notes",
	/** Presentation viewer — button that opens the speaker notes pane */
	previewPptxNotesShow: "Show notes",
	/** Presentation viewer — button that closes the speaker notes pane */
	previewPptxNotesHide: "Hide notes",
	/** Presentation viewer — accessible name of the handle that resizes the speaker notes pane */
	previewPptxNotesResize: "Resize notes",
	/** Presentation viewer — the notes pane when the slide has no speaker notes */
	previewPptxNotesEmpty: "This slide has no notes.",
	/** Presentation viewer — command bar button: starts the slide show from the slide in view */
	previewPptxStartShow: "Present",
	/** Presentation viewer — accessible name of the full-screen slide show */
	previewPptxShowLabel: "Slide show",
	/** Presentation viewer — command bar button: shows or hides the slide list */
	previewPptxRailToggle: "Slide list",
	/** Presentation viewer — the deck could not be read: damaged, or not a presentation */
	previewPptxMalformed: "This file is damaged or isn't a presentation.",
	/** Presentation viewer — the deck is larger than the viewer can open (too many slides, shapes or parts) */
	previewPptxTooLarge: "This presentation is too large to open here.",
	/** Presentation viewer — the deck is protected with Information Rights Management */
	previewPptxRightsManaged: "This presentation is protected with rights management, so it can't be opened here.",
	/** Presentation viewer — the deck is encrypted in a way the viewer can't read */
	previewPptxUnsupportedEncryption: "This presentation is encrypted in a way that can't be opened here.",
	/** Presentation viewer — the deck's encryption is damaged */
	previewPptxDamagedEncryption: "This presentation's encryption is damaged, so it can't be opened.",
	/** Presentation viewer — the deck uses a format or feature the viewer can't show yet */
	previewPptxUnsupported: "This presentation can't be shown here yet.",
	/** Presentation viewer — any other failure to open */
	previewPptxLoadFailed: "This presentation couldn't be opened.",
	/** Presentation viewer — a deck that was open stopped (its worker failed); Retry opens it again */
	previewPptxStoppedWorking: "This presentation stopped working. Try opening it again.",
	/** Presentation viewer — in the slide's place while the deck waits for its password */
	previewPptxPasswordMessage: "This presentation is protected with a password.",
	/** Presentation viewer — button that brings back a dismissed password prompt */
	previewPptxPasswordEnter: "Enter password",
	/** Password prompt — title */
	previewPptxPasswordTitle: "Password required",
	/** Password prompt — body; {{name}} is the file name */
	previewPptxPasswordBody: "Enter the password to open {{name}}.",
	/** Password prompt — under the field after a wrong password */
	previewPptxPasswordWrong: "That password isn't right. Try again.",
	/** Password prompt — field label */
	previewPptxPasswordLabel: "Password",
	/** Password prompt — submit button */
	previewPptxPasswordSubmit: "Open",
	/** Password prompt — shown while the password is checked (it can take a few seconds) */
	previewPptxPasswordChecking: "Checking password…",
	/** Presentation viewer — read-only note: the deck carries a digital signature, which editing would break */
	previewPptxReadOnlySigned: "Read-only: this presentation is digitally signed, and editing it would break the signature.",
	/** Presentation viewer — read-only note: the deck is written in Strict Open XML, which is shown but not edited here */
	previewPptxReadOnlyStrict: "Read-only: this presentation uses Strict Open XML, which can be viewed but not edited here.",
	/** Presentation viewer — read-only note: the author protected the deck with a password for changes */
	previewPptxReadOnlyWriteProtected: "Read-only: this presentation needs a password to be changed.",
	/** Presentation viewer — read-only note: part of the deck is damaged, so it is not edited */
	previewPptxReadOnlyMalformed: "Read-only: part of this presentation is damaged.",
	/** Presentation viewer — note: the deck carries macros, which are kept in the file but never run */
	previewPptxMacros: "This presentation contains macros. They're kept in the file but never run.",
	/** Presentation viewer — note: a picture, sound or video is linked from outside the file and is not loaded */
	previewPptxLinkedFile: "Linked files outside this presentation aren't loaded.",
	/** Presentation viewer — note: a slide action (run a program, a macro, open a local file) was clicked and is not run */
	previewPptxRefusedAction: "This action can't run here.",
	/** Presentation viewer — accessible name of a clickable shape that opens a link; {{target}} is the address */
	previewPptxActionLink: "Open {{target}}",
	/** Presentation viewer — accessible name of a clickable shape that goes to another slide or a custom show */
	previewPptxActionJump: "Go to another slide",
	/** Presentation viewer — accessible name of a clickable shape that plays its sound or video */
	previewPptxActionMedia: "Play media",
	/** Presentation viewer — accessible name of a clickable shape whose action (a program, a macro, a file) is not run */
	previewPptxActionRefused: "An action that can't run here",
	/** Presentation viewer — accessible name of a clickable shape with alt text: {{name}} is the alt text, {{action}} what a click does in lower case, e.g. "Logo, play media" */
	previewPptxActionNamed: "{{name}}, {{action}}",
	/** Presentation viewer — dismiss button of a note */
	previewPptxDismiss: "Dismiss"
} as const
