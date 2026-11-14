// "settings" namespace — the keyboard shortcuts list (Settings > Keyboard and the ? dialog). Spread into settings.ts;
// same catalog rules (flat, camelCase, keys unique across the namespace's files, no literal '.' or ':').
export const settingsKeyboard = {
	// ── Page actions ─────────────────────────────────────────────────────────
	/** Settings > Keyboard — button that saves every custom shortcut to a JSON file */
	keyboardExport: "Export",
	/** Settings > Keyboard — button that loads custom shortcuts from a JSON file exported earlier */
	keyboardImport: "Import",
	/** Settings > Keyboard — button that puts every shortcut back to its default */
	keyboardResetAll: "Reset all",
	/** Settings > Keyboard — reset-all confirmation title */
	keyboardResetAllTitle: "Reset all shortcuts?",
	/** Settings > Keyboard — reset-all confirmation body */
	keyboardResetAllBody: "Every shortcut goes back to its default. Shortcuts you turned off come back on.",
	/** Settings > Keyboard — reset-all confirmation button */
	keyboardResetAllConfirm: "Reset all",
	/** Settings > Keyboard — file name of an exported shortcuts file, without the extension */
	keyboardExportFileName: "filen-keyboard-shortcuts",
	/** Settings > Keyboard — toast after an export */
	keyboardExported: "Shortcuts exported",
	/** Settings > Keyboard — error when an imported file is not a Filen shortcuts export */
	keyboardImportInvalid: "This file is not a Filen shortcuts export.",
	/** Settings > Keyboard — import preview dialog title */
	keyboardImportTitle: "Import shortcuts",
	/** Settings > Keyboard — import preview body; {{count}} is how many shortcuts change */
	keyboardImportBody_one: "{{count}} shortcut changes. Shortcuts the file does not mention stay as they are.",
	/** Settings > Keyboard — import preview body; {{count}} is how many shortcuts change */
	keyboardImportBody_other: "{{count}} shortcuts change. Shortcuts the file does not mention stay as they are.",
	/** Settings > Keyboard — import preview when the file changes nothing */
	keyboardImportNothing: "Your shortcuts already match this file.",
	/** Settings > Keyboard — import preview note; {{count}} is how many entries name shortcuts this version does not have */
	keyboardImportUnknown_one: "{{count}} entry names a shortcut this version of Filen does not have and is skipped.",
	/** Settings > Keyboard — import preview note; {{count}} is how many entries name shortcuts this version does not have */
	keyboardImportUnknown_other: "{{count}} entries name shortcuts this version of Filen does not have and are skipped.",
	/** Settings > Keyboard — import preview row for the single-key shortcuts switch; {{state}} is keyboardOn or keyboardOff */
	keyboardImportCharacterKeys: "Single-key shortcuts: {{state}}",
	/** Settings > Keyboard — the single-key switch's state in the import preview */
	keyboardOn: "on",
	/** Settings > Keyboard — the single-key switch's state in the import preview */
	keyboardOff: "off",
	/** Settings > Keyboard — import preview confirm button */
	keyboardImportConfirm: "Import",
	/** Settings > Keyboard — toast after an import */
	keyboardImported: "Shortcuts imported",
	/** Settings > Keyboard — note under the page description: what is and is not kept */
	keyboardScopeNote: "Saved on this device for your account. Use Export to take them to another device.",

	// ── Search and filters ───────────────────────────────────────────────────
	/** Shortcuts list — search field placeholder */
	keyboardSearchPlaceholder: "Search shortcuts",
	/** Shortcuts list — search field accessible name */
	keyboardSearchLabel: "Search shortcuts by name",
	/** Shortcuts list — toggle in the search field that records keys to find the shortcuts using them */
	keyboardSearchByKeys: "Search by keys",
	/** Shortcuts list — prompt while the search-by-keys toggle records */
	keyboardSearchRecording: "Press keys to search",
	/** Shortcuts list — button clearing the recorded keys of a key search */
	keyboardSearchClearKeys: "Clear the keys",
	/** Shortcuts list — filter chips group accessible name */
	keyboardFilters: "Show",
	/** Shortcuts list — filter chip: every shortcut */
	keyboardFilterAll: "All",
	/** Shortcuts list — filter chip: shortcuts the user changed; {{count}} is how many */
	keyboardFilterChanged: "Changed {{count}}",
	/** Shortcuts list — filter chip: shortcuts sharing keys with another; {{count}} is how many */
	keyboardFilterConflicts: "Conflicts {{count}}",
	/** Shortcuts list — filter chip: shortcuts without keys; {{count}} is how many */
	keyboardFilterUnset: "Not set {{count}}",
	/** Shortcuts list — shown when the search and filter match nothing */
	keyboardNoMatches: "No shortcuts match",

	// ── Single-key shortcuts ─────────────────────────────────────────────────
	/** Shortcuts list — switch turning off shortcuts that are a single letter, number or symbol key */
	keyboardCharacterKeys: "Single-key shortcuts",
	/** Shortcuts list — description of the single-key switch */
	keyboardCharacterKeysDescription:
		"Shortcuts that are one letter, number or symbol, like D or ?. A running slideshow and the video player keep theirs.",
	/** Shortcuts list — tooltip on a key that does not work while single-key shortcuts are off */
	keyboardCharacterKeyOff: "Off while single-key shortcuts are off",

	// ── Groups ───────────────────────────────────────────────────────────────
	/** Shortcuts list — sub-group of the Editor group: viewing PDFs and images */
	keyboardSectionViewer: "PDF & image viewer",
	/** Shortcuts list — sub-group of the Editor group: editing an image */
	keyboardSectionImageEditor: "Image editor",
	/** Shortcuts list — sub-group of the Editor group: editing a video */
	keyboardSectionVideoEditor: "Video editor",
	/** Shortcuts list — sub-group of the Editor group: code and Markdown files and notes */
	keyboardSectionCode: "Code & Markdown",
	/** Shortcuts list — sub-group of the Editor group: the presentation editor's slides */
	keyboardSectionPresentation: "Presentation editor",
	/** Shortcuts list — sub-group of the Editor group: shapes on a slide */
	keyboardSectionPresentationObjects: "Presentation objects",
	/** Shortcuts list — sub-group of the Editor group: text on a slide */
	keyboardSectionPresentationText: "Presentation text",
	/** Shortcuts list — sub-group of the Editor group: a running slideshow */
	keyboardSectionSlideshow: "Slideshow",
	/** Shortcuts list — sub-group of the Editor group: Word documents */
	keyboardSectionWord: "Word",
	/** Shortcuts list — sub-group of the Editor group: spreadsheets */
	keyboardSectionSheet: "Spreadsheet",
	/** Shortcuts list — sub-group of the Editor group: browsing the files inside an archive (ZIP, 7-Zip, tarball) */
	keyboardSectionArchive: "Archive browser",
	/** Shortcuts list — button resetting every shortcut of one group; {{group}} is the group's name */
	keyboardResetGroup: "Reset {{group}}",

	// ── Rows ─────────────────────────────────────────────────────────────────
	/** Shortcuts list — button adding another key combination to a shortcut */
	keyboardAdd: "Add shortcut",
	/** Shortcuts list — accessible name of a key chip, which records a replacement; {{keys}} is the combination */
	keyboardChangeKeys: "Change {{keys}}",
	/** Shortcuts list — accessible name of a key chip's remove button; {{keys}} is the combination */
	keyboardRemoveKeys: "Remove {{keys}}",
	/** Shortcuts list — the row's more-actions menu button */
	keyboardMore: "More",
	/** Shortcuts list — row menu item opening the special keys picker (Escape, Tab, F-keys…) */
	keyboardAddSpecial: "Add special key…",
	/** Shortcuts list — row menu item that turns a shortcut off */
	keyboardTurnOff: "Turn off",
	/** Shortcuts list — prompt while recording; {{action}} is the shortcut's name */
	keyboardRecordingAnnounce: "Recording a shortcut for {{action}}. Press the keys, or Escape to cancel.",
	/** Shortcuts list — badge on a shortcut sharing keys with another */
	keyboardConflict: "Conflict",
	/** Shortcuts list — conflict note after recording; {{keys}} is the combination, {{actions}} the shortcuts holding it */
	keyboardConflictWith: "{{keys}} is already used by {{actions}}",
	/** Shortcuts list — conflict panel button: keep the new keys here and take them off the other shortcuts */
	keyboardReassign: "Reassign",
	/** Shortcuts list — conflict panel button: give the other shortcut the keys this one had */
	keyboardSwap: "Swap",
	/** Shortcuts list — existing-conflict panel button removing the shared keys from the other shortcut */
	keyboardRemoveThere: "Remove from {{action}}",
	/** Shortcuts list — warning after saving keys a browser keeps */
	keyboardReservedBrowser: "Browsers keep {{keys}} for themselves, so it may never reach Filen on the web.",
	/** Shortcuts list — warning after saving keys Firefox keeps */
	keyboardReservedFirefox: "Firefox keeps {{keys}} for itself, so it may not work there.",
	/** Shortcuts list — warning (web) or refusal (desktop app) for keys the operating system keeps */
	keyboardReservedSystem: "Your system keeps {{keys}} for itself.",
	/** Shortcuts list — refusal for keys the desktop app's menu uses */
	keyboardReservedAppMenu: "The app menu uses {{keys}}.",
	/** Shortcuts list — button dismissing a warning */
	keyboardDismiss: "Dismiss",

	// ── Special keys picker ──────────────────────────────────────────────────
	/** Special keys picker — title */
	keyboardSpecialTitle: "Add a special key",
	/** Special keys picker — description */
	keyboardSpecialDescription: "For keys the recorder cannot take, like Escape and Tab, or to pick keys without pressing them.",
	/** Special keys picker — key select label */
	keyboardSpecialKey: "Key",
	/** Special keys picker — modifier toggles group label */
	keyboardSpecialModifiers: "Held with",
	/** Special keys picker — confirm button */
	keyboardSpecialAdd: "Add",

	// ── Key names for screen readers ─────────────────────────────────────────
	/** Spoken name of the Command key (Mac) */
	keyboardKeyCommand: "Command",
	/** Spoken name of the Control key */
	keyboardKeyControl: "Control",
	/** Spoken name of the Option key (Mac) */
	keyboardKeyOption: "Option",
	/** Spoken name of the Alt key */
	keyboardKeyAlt: "Alt",
	/** Spoken name of the Shift key */
	keyboardKeyShift: "Shift",
	/** Spoken name of the Windows key */
	keyboardKeyWindows: "Windows",
	/** Spoken name of the Super key (Linux) */
	keyboardKeySuper: "Super",
	/** Spoken name of the Enter / Return key */
	keyboardKeyEnter: "Enter",
	/** Spoken name of the Backspace key (labelled Delete on a Mac) */
	keyboardKeyBackspace: "Backspace",
	/** Spoken name of the forward Delete key */
	keyboardKeyDelete: "Delete",
	/** Spoken name of the Escape key */
	keyboardKeyEscape: "Escape",
	/** Spoken name of the Up arrow key */
	keyboardKeyArrowUp: "Up arrow",
	/** Spoken name of the Down arrow key */
	keyboardKeyArrowDown: "Down arrow",
	/** Spoken name of the Left arrow key */
	keyboardKeyArrowLeft: "Left arrow",
	/** Spoken name of the Right arrow key */
	keyboardKeyArrowRight: "Right arrow",
	/** Spoken name of the Page Up key */
	keyboardKeyPageUp: "Page Up",
	/** Spoken name of the Page Down key */
	keyboardKeyPageDown: "Page Down",

	// ── Where an action works ────────────────────────────────────────────────
	/** Shortcuts list — where the shortcut works: while a slideshow runs */
	keyboardHintSlideshow: "While a slideshow runs",
	/** Shortcuts list — where the shortcut works: in the presentation editor */
	keyboardHintPresentationEditor: "In the presentation editor",
	/** Shortcuts list — where the shortcut works: in the presentation's slide list */
	keyboardHintSlideList: "In the slide list",
	/** Shortcuts list — where the shortcut works: with shapes selected on a slide */
	keyboardHintSlideShapes: "With shapes selected on a slide",
	/** Shortcuts list — where the shortcut works: while editing text on a slide */
	keyboardHintSlideText: "While editing text on a slide",
	/** Shortcuts list — where the shortcut works: in the PDF viewer */
	keyboardHintPdf: "In the PDF viewer",
	/** Shortcuts list — where the shortcut works: in the image viewer */
	keyboardHintImage: "In the image viewer",
	/** Shortcuts list — where the shortcut works: in Markdown files and notes */
	keyboardHintMarkdown: "In Markdown files and notes",
	/** Shortcuts list — where the shortcut works: while music plays or is paused */
	keyboardHintAudio: "While the audio player has a queue",
	/** Shortcuts list — where the shortcut works: also from the macOS menu bar of the desktop app */
	keyboardHintAppMenu: "Also in the menu bar",

	// ── App and window actions ───────────────────────────────────────────────
	/** Shortcut name — shows or hides the module sidebar next to the icon rail */
	keyboardActionToggleSidebar: "Show or hide the sidebar",
	/** Shortcut name — moves keyboard focus to the next area of the window (icon rail, sidebar, content, assistant) */
	keyboardActionNextPane: "Go to the next area",
	/** Shortcut name — moves keyboard focus to the previous area of the window */
	keyboardActionPreviousPane: "Go to the previous area",
	/** Shortcut name — moves keyboard focus to the notifications in the corner of the window */
	keyboardActionFocusNotifications: "Go to notifications",
	/** Shortcut name — closes every notification on screen */
	keyboardActionDismissNotifications: "Dismiss all notifications",
	/** Shortcut name — switches to the light theme */
	keyboardActionThemeLight: "Use the light theme",
	/** Shortcut name — switches to the dark theme */
	keyboardActionThemeDark: "Use the dark theme",
	/** Shortcut name — makes the theme follow the system's light or dark setting */
	keyboardActionThemeSystem: "Use the system theme",
	/** Shortcut name — opens the account menu at the bottom of the icon rail */
	keyboardActionAccountMenu: "Open the account menu",
	/** Shortcut name (desktop app) — locks the app behind its PIN right away */
	keyboardActionLock: "Lock Filen",
	/** Shortcut name (desktop app) — closes the open dialog, such as a file preview, or the window when none is open */
	keyboardActionClose: "Close the dialog or window",
	/** Shortcut name (desktop app) — goes back to the previous page */
	keyboardActionBack: "Back",
	/** Shortcut name (desktop app) — goes forward again after going back */
	keyboardActionForward: "Forward",
	/** Shortcut name (desktop app) — makes everything in the window larger */
	keyboardActionZoomIn: "Zoom in",
	/** Shortcut name (desktop app) — makes everything in the window smaller */
	keyboardActionZoomOut: "Zoom out",
	/** Shortcut name (desktop app) — puts the window's zoom back to 100% */
	keyboardActionZoomReset: "Actual size",
	/** Shortcut name (desktop app) — turns full screen on or off */
	keyboardActionFullScreen: "Full screen",
	/** Shortcut name (desktop app) — quits the app */
	keyboardActionQuit: "Quit Filen",
	/** Keyboard shortcut — opens the settings section above the open one in the sidebar */
	keyboardActionPreviousSection: "Previous settings section",
	/** Keyboard shortcut — opens the settings section below the open one in the sidebar */
	keyboardActionNextSection: "Next settings section",
	/** Keyboard shortcut — focuses the search box of the Events page or of the keyboard shortcuts list */
	keyboardActionSearch: "Search",
	/** Shortcuts list — where the shortcut works: on the Events page and in the keyboard shortcuts list */
	keyboardHintSettingsSearch: "In Events and in the keyboard shortcuts",
	/** Keyboard shortcut — shows the next newer event in the event details dialog */
	keyboardActionPreviousEvent: "Previous event",
	/** Keyboard shortcut — shows the next older event in the event details dialog */
	keyboardActionNextEvent: "Next event",
	/** Keyboard shortcut — copies the event's details, when no text is selected */
	keyboardActionCopyEvent: "Copy event details",
	/** Keyboard shortcut — shows the event's file or directory in Cloud Drive */
	keyboardActionShowEventInDrive: "Show event item in Cloud Drive",
	/** Shortcuts list — where the shortcut works: in an event's details */
	keyboardHintEventDetails: "In an event's details",
	/** Shortcuts list — where the shortcut works: in the full-screen file preview */
	keyboardHintPreview: "In the file preview",
	/** Shortcuts list — where the shortcut works: in the image viewer while the image is zoomed in */
	keyboardHintImageZoomed: "In the image viewer, zoomed in",
	/** Shortcuts list — where the shortcut works: in a document's find field */
	keyboardHintFindField: "In the find field",
	/** Shortcut name — in the Word, spreadsheet and presentation editors, hides the ribbon's commands below its tabs or shows them again */
	keyboardActionToggleRibbon: "Show tabs only or the whole ribbon",
	/** Shortcut name — in the spreadsheet and presentation editors and the PDF viewer, opens printing for the open file */
	keyboardActionPrint: "Print"
} as const
