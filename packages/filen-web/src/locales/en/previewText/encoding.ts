// "preview" namespace, text family — the text editor's encoding menu and the save refused for a character the file's
// encoding cannot hold. Spread into preview.ts; same catalog rules.
export const previewTextEncoding = {
	/** Text editor — status: accessible name of the encoding menu button; {{encoding}} is the file's encoding (e.g. "Windows-1251") */
	previewTextEncodingMenu: "Encoding: {{encoding}}",
	/** Text editor — status: the encoding after "Convert to UTF-8", until the file is saved; {{encoding}} is "UTF-8" or "UTF-8 with BOM" */
	previewTextEncodingConverted: "{{encoding}} (unsaved)",
	/** Text editor — encoding menu: the encoding the file was detected as; {{encoding}} is its name (e.g. "Windows-1251") */
	previewTextEncodingDetected: "Detected: {{encoding}}",
	/** Text editor — encoding menu: submenu reading the file again with another encoding (disabled while there are unsaved edits) */
	previewTextEncodingReopen: "Reopen with encoding",
	/** Text editor — encoding menu and the save-refused dialog: from now on, save the file as UTF-8 */
	previewTextConvertToUtf8: "Convert to UTF-8",
	/** Text editor — dialog title: a save was refused because the file's encoding cannot hold a typed character */
	previewTextUnencodableTitle: "Can't save in this encoding",
	/** Text editor — dialog body; {{encoding}} is the file's encoding, {{char}} the character, {{line}}/{{column}} where it is */
	previewTextUnencodableBody:
		"{{encoding}} has no character “{{char}}” (line {{line}}, column {{column}}). Convert the file to UTF-8 to save it, or remove the character.",
	/** Text editor — dialog title before converting a file some of whose bytes could not be read */
	previewTextConvertLossyTitle: "Replace unreadable characters?",
	/** Text editor — dialog body; {{encoding}} is the encoding the file was read with (e.g. "UTF-8", "Shift JIS") */
	previewTextConvertLossyBody:
		"Some bytes of this file can't be read as {{encoding}} and show as �. Converting to UTF-8 writes � in their place: once you save, the original bytes are gone.",
	/** Text editor — toast: saving the unsaved edits as a new file was refused because the file's encoding cannot hold a typed character */
	previewTextUnencodableSaveAsNew:
		"Your edits hold a character this file's encoding can't store. Keep your edits, convert the file to UTF-8 from its encoding menu, then save."
} as const
