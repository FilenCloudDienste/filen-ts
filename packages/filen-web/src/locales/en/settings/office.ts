// "settings" namespace — Settings > Office: how documents, spreadsheets and presentations are edited. Spread into
// settings.ts; same catalog rules (flat, camelCase, keys unique across the namespace's files, no literal '.' or ':').
export const settingsOffice = {
	/** Settings sidebar — Office section nav label and that section's page heading (document, spreadsheet and presentation editing) */
	settingsSectionOffice: "Office",

	// ── General (synced) ─────────────────────────────────────────────────────
	/** Settings > Office — description of the General group; its title is settingsGroupGeneral */
	settingsOfficeGeneralDescription: "For documents, spreadsheets and presentations, synced across your devices",
	/** Settings > Office — row label: the name comments and tracked changes in documents are signed with */
	settingsDocumentsAuthorName: "Author name",
	/** Settings > Office — author name row description */
	settingsDocumentsAuthorNameDescription: "Shown on your comments and tracked changes.",
	/** Settings > Office — author name row value while none was given */
	settingsDocumentsAuthorNameUnset: "Not set",
	/** Settings > Office — button opening the author name or initials dialog */
	settingsDocumentsAuthorNameEdit: "Change",
	/** Settings > Office — row label: the initials comments carry (Word's "Initials") */
	settingsOfficeAuthorInitials: "Author initials",
	/** Settings > Office — author initials row description */
	settingsOfficeAuthorInitialsDescription: "Shown on your comments in documents and presentations.",
	/** Settings > Office — author initials row value while none were given: they are made from the author name */
	settingsOfficeAuthorInitialsFromName: "From your name",
	/** Settings > Office — author initials dialog title */
	settingsOfficeAuthorInitialsDialogTitle: "Author initials",
	/** Settings > Office — author initials dialog body; {{max}} is the most characters the initials may have */
	settingsOfficeAuthorInitialsDialogBody: "Up to {{max}} characters, shown on your comments.",
	/** Settings > Office — author initials dialog field label */
	settingsOfficeAuthorInitialsLabel: "Initials",
	/** Settings > Office — author initials dialog submit button */
	settingsOfficeAuthorInitialsSave: "Save",
	/** Settings > Office — author initials dialog second button: go back to initials made from the author name */
	settingsOfficeAuthorInitialsUseName: "Use initials from name",
	/** Settings > Office — row label: save edits automatically */
	settingsDocumentsAutosave: "Save automatically",
	/** Settings > Office — autosave row description */
	settingsOfficeAutosaveDescription: "Saves a new version once you pause editing.",
	/** Settings > Office — row label: how long after the last edit an autosave happens */
	settingsOfficeAutosaveDelay: "Autosave delay",
	/** Settings > Office — autosave delay row description; very large presentations follow their own longer schedule */
	settingsOfficeAutosaveDelayDescription: "How long after your last edit. Very large presentations save less often.",
	/** Settings > Office — autosave delay option; {{count}} is a whole number of seconds */
	settingsOfficeAutosaveDelaySeconds_one: "{{count}} second",
	settingsOfficeAutosaveDelaySeconds_other: "{{count}} seconds",
	/** Settings > Office — autosave delay option; {{count}} is a whole number of minutes */
	settingsOfficeAutosaveDelayMinutes_one: "{{count}} minute",
	settingsOfficeAutosaveDelayMinutes_other: "{{count}} minutes",

	// ── Proofing (synced) ────────────────────────────────────────────────────
	/** Settings > Office — group title: spelling settings (Word's "Proofing") */
	settingsOfficeProofingTitle: "Proofing",
	/** Settings > Office — proofing group description */
	settingsOfficeProofingDescription: "Spelling in documents, synced across your devices",
	/** Settings > Office — switch: mark misspelled words while typing (Word's "Check spelling as you type") */
	settingsOfficeSpellCheck: "Check spelling as you type",
	/** Settings > Office — spell check switch description; dictionaries are downloaded only while it is on */
	settingsOfficeSpellCheckDescription: "Marks misspelled and repeated words. Dictionaries are downloaded only while this is on.",
	/** Settings > Office — row label: the language text is checked in when the document names none */
	settingsOfficeProofingLanguage: "Proofing language",
	/** Settings > Office — proofing language row description */
	settingsOfficeProofingLanguageDescription: "For text the document gives no language.",
	/** Settings > Office — select option: follow the browser's language (proofing language, regional format) */
	settingsOfficeBrowserLanguage: "Browser language",
	/** Settings > Office — switch: words written all in capitals are not checked */
	settingsOfficeIgnoreUppercase: "Ignore words in UPPERCASE",
	/** Settings > Office — ignore uppercase switch description */
	settingsOfficeIgnoreUppercaseDescription: "Abbreviations and acronyms are not marked.",
	/** Settings > Office — switch: words with digits in them are not checked */
	settingsOfficeIgnoreNumbers: "Ignore words that contain numbers",
	/** Settings > Office — ignore numbers switch description */
	settingsOfficeIgnoreNumbersDescription: "Codes such as product numbers are not marked.",
	/** Settings > Office — switch: web addresses, email addresses and file paths are not checked */
	settingsOfficeIgnoreAddresses: "Ignore internet and file addresses",
	/** Settings > Office — ignore addresses switch description */
	settingsOfficeIgnoreAddressesDescription: "Links, email addresses and file paths are not marked.",
	/** Settings > Office — switch: a word written twice in a row is marked */
	settingsOfficeFlagRepeated: "Flag repeated words",
	/** Settings > Office — flag repeated words switch description */
	settingsOfficeFlagRepeatedDescription: "Marks a word written twice in a row.",
	/** Settings > Office — row label: the words the user added to the spelling dictionary */
	settingsOfficeDictionary: "Custom dictionary",
	/** Settings > Office — custom dictionary row description */
	settingsOfficeDictionaryDescription: "Words you added from the spelling menu, synced across your devices.",
	/** Settings > Office — button opening the custom dictionary */
	settingsOfficeDictionaryManage: "Manage",
	/** Settings > Office — custom dictionary dialog description; {{count}} is the number of words in it */
	settingsOfficeDictionaryCount_one: "{{count}} word",
	settingsOfficeDictionaryCount_other: "{{count}} words",
	/** Settings > Office — custom dictionary dialog filter field placeholder and accessible name */
	settingsOfficeDictionaryFilter: "Find a word",
	/** Settings > Office — custom dictionary dialog while it holds no words */
	settingsOfficeDictionaryEmpty: "No words yet. Add one from the spelling menu in a document.",
	/** Settings > Office — custom dictionary dialog when no word matches the filter */
	settingsOfficeDictionaryNoMatch: "No matching words",
	/** Settings > Office — custom dictionary dialog when the dictionary could not be read */
	settingsOfficeDictionaryLoadFailed: "The dictionary couldn't be loaded.",
	/** Settings > Office — accessible name of the button removing one word from the custom dictionary; {{word}} is the word */
	settingsOfficeDictionaryRemove: "Remove {{word}}",

	// ── Regional (synced) ────────────────────────────────────────────────────
	/** Settings > Office — group title: number and date formats and paper */
	settingsOfficeRegionalTitle: "Regional",
	/** Settings > Office — regional group description */
	settingsOfficeRegionalDescription: "Formats and paper, synced across your devices",
	/** Settings > Office — row label: the locale numbers and dates are typed and shown in, in spreadsheets */
	settingsOfficeRegionalFormat: "Regional format",
	/** Settings > Office — regional format row description; {{example}} is a number and a date written in the chosen format */
	settingsOfficeRegionalFormatDescription: "Numbers, dates and separators in spreadsheets, such as {{example}}.",
	/** Settings > Office — row label: the paper new documents and spreadsheets are made on */
	settingsOfficePaperSize: "Paper size for new files",
	/** Settings > Office — paper size row description */
	settingsOfficePaperSizeDescription: "For new documents and spreadsheets.",
	/** Settings > Office — paper size option: Letter in the regions that use it, A4 elsewhere */
	settingsOfficePaperAutomatic: "Automatic",
	/** Settings > Office — paper size option: ISO A4 (210 × 297 mm) */
	settingsOfficePaperA4: "A4",
	/** Settings > Office — paper size option: US Letter (8.5 × 11 in) */
	settingsOfficePaperLetter: "Letter",

	// ── Word documents (this device) ─────────────────────────────────────────
	/** Settings > Office — group title: how Word documents open */
	settingsOfficeWordTitle: "Word documents",
	/** Settings > Office — Word documents group description */
	settingsOfficeWordDescription: "On this device",
	/** Settings > Office — row label: how comments and tracked changes show when a document opens (Word's "Display for Review"); the options are preview:previewDocxMarkup* */
	settingsOfficeMarkupView: "Markup when opening",
	/** Settings > Office — markup row description */
	settingsOfficeMarkupViewDescription: "How comments and tracked changes show at first.",
	/** Settings > Office — row label: whether documents open as pages or reflowed to the screen */
	settingsOfficeOpenIn: "Open documents in",
	/** Settings > Office — open documents in row description */
	settingsOfficeOpenInDescription: "Automatic uses Mobile view on narrow screens.",
	/** Settings > Office — open documents in option: the width decides */
	settingsOfficeOpenInAutomatic: "Automatic",
	/** Settings > Office — open documents in option: the document's pages (Word's Print Layout); the other option is preview:previewDocxMobileView */
	settingsOfficeOpenInPages: "Page view",
	/** Settings > Office — switch: show paragraph marks, spaces and tabs (Word's Show/Hide ¶) */
	settingsOfficeFormattingMarks: "Show formatting marks",
	/** Settings > Office — formatting marks switch description */
	settingsOfficeFormattingMarksDescription: "Paragraph marks, spaces, tabs and breaks.",

	// ── Editor layout (this device) ──────────────────────────────────────────
	/** Settings > Office — group title: how the editors are laid out */
	settingsOfficeLayoutTitle: "Editor layout",
	/** Settings > Office — editor layout group description */
	settingsOfficeLayoutDescription: "On this device",
	/** Settings > Office — switch: the ribbon shows only its tab names until one is picked (Office's "Show tabs only") */
	settingsOfficeRibbonTabsOnly: "Show ribbon tabs only",
	/** Settings > Office — ribbon switch description */
	settingsOfficeRibbonTabsOnlyDescription: "The commands show when you pick a tab.",
	/** Settings > Office — switch: a presentation opens with its slide thumbnails beside the slide */
	settingsOfficeSlideRail: "Show slide thumbnails",
	/** Settings > Office — slide thumbnails switch description */
	settingsOfficeSlideRailDescription: "When a presentation opens.",
	/** Settings > Office — switch: a presentation opens with the speaker notes under the slide */
	settingsOfficeNotesPane: "Show speaker notes",
	/** Settings > Office — speaker notes switch description */
	settingsOfficeNotesPaneDescription: "When a presentation opens."
} as const
