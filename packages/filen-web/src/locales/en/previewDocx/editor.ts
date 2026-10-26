// "preview" namespace, Word document editor — the editor itself: its toolbar row, clipboard and spelling menu, locked
// parts, saving and the author prompt. Spread into preview.ts; same catalog rules.
export const previewDocxEditor = {
	/** Docx editor — toolbar button: undo the last change */
	previewDocxUndo: "Undo",
	/** Docx editor — toolbar button: redo the change last undone */
	previewDocxRedo: "Redo",
	/** Docx editor — toolbar button: bold text */
	previewDocxBold: "Bold",
	/** Docx editor — toolbar button: italic text */
	previewDocxItalic: "Italic",
	/** Docx editor — toolbar button: underlined text */
	previewDocxUnderline: "Underline",
	/** Docx editor — toolbar button: struck-through text */
	previewDocxStrikethrough: "Strikethrough",
	/** Docx editor — toolbar button: remove direct character formatting */
	previewDocxClearFormatting: "Clear formatting",
	/** Docx editor — accessible name of the paragraph style picker */
	previewDocxParagraphStyle: "Paragraph style",
	/** Docx editor — paragraph style picker shows this when the selected paragraphs have different styles */
	previewDocxStyleMixed: "Several styles",
	/** Docx editor — paragraph style: Word's Normal style */
	previewDocxStyleNormal: "Normal",
	/** Docx editor — paragraph style: Word's Title style */
	previewDocxStyleTitle: "Title",
	/** Docx editor — paragraph style: Word's Subtitle style */
	previewDocxStyleSubtitle: "Subtitle",
	/** Docx editor — paragraph style: a heading level */
	previewDocxStyleHeading: "Heading {{level}}",
	/** Docx editor — paragraph style: Word's Quote style */
	previewDocxStyleQuote: "Quote",
	/** Docx editor — toolbar button: align paragraph to the start (left in left-to-right text) */
	previewDocxAlignStart: "Align left",
	/** Docx editor — toolbar button: center paragraph */
	previewDocxAlignCenter: "Center",
	/** Docx editor — toolbar button: align paragraph to the end (right in left-to-right text) */
	previewDocxAlignEnd: "Align right",
	/** Docx editor — toolbar button: justify paragraph */
	previewDocxAlignJustify: "Justify",
	/** Docx editor — toolbar button: bulleted list */
	previewDocxBulletList: "Bulleted list",
	/** Docx editor — toolbar button: numbered list */
	previewDocxNumberedList: "Numbered list",
	/** Docx editor — toolbar button: move list item one level in */
	previewDocxIndent: "Increase indent",
	/** Docx editor — toolbar button: move list item one level out */
	previewDocxOutdent: "Decrease indent",
	/** Docx editor — overflow menu checkbox: save changes automatically after a pause in editing */
	previewDocxAutosave: "Save automatically",
	/** Docx editor — toolbar button opening find with the replace field */
	previewDocxFindReplaceAction: "Find and replace",
	/** Docx editor — toast after Replace all, for one replacement */
	previewDocxReplacedCount_one: "Replaced {{count}} match",
	/** Docx editor — as previewDocxReplacedCount_one, for several */
	previewDocxReplacedCount_other: "Replaced {{count}} matches",
	/** Docx editor — toast when Replace all finds matches but every one is in locked content or deleted text */
	previewDocxReplaceAllUnreplaceable: "None of these matches can be replaced: they are in locked content or deleted text.",
	/** Docx editor — toast when Replace all finds too many matches in content controls to replace them at once */
	previewDocxReplaceAllTooLarge: "Too many of these matches are in content controls to replace them all at once.",
	/** Docx editor — context and touch menu: cut the selection */
	previewDocxCut: "Cut",
	/** Docx editor — context and touch menu: copy the selection */
	previewDocxCopy: "Copy",
	/** Docx editor — context and touch menu: paste the clipboard */
	previewDocxPaste: "Paste",
	/** Docx editor — context and touch menu: select the whole document */
	previewDocxSelectAll: "Select all",
	/** Docx editor — toast when the browser refuses access to the clipboard; names the keyboard shortcut that still works */
	previewDocxClipboardBlocked: "Access to the clipboard was blocked. Use {{shortcut}} instead.",
	/** Docx editor — context menu while spelling suggestions load */
	previewDocxSpellingLoading: "Looking for suggestions…",
	/** Docx editor — context menu when a misspelled word has no suggestions */
	previewDocxSpellingNone: "No suggestions",
	/** Docx editor — context menu: stop marking this word in this document */
	previewDocxSpellingIgnoreAll: "Ignore all",
	/** Docx editor — context menu: add the word to the user's own dictionary (synced across devices) */
	previewDocxSpellingAdd: "Add to dictionary",
	/** Docx editor — context menu on a word repeated right after itself: delete the repetition */
	previewDocxSpellingDeleteRepeated: "Delete repeated word",
	/** Docx editor — context menu on a repeated word: stop flagging this repetition */
	previewDocxSpellingIgnoreRepeated: "Ignore",
	/** Docx editor — toast after opening: blocks the save check could not prove safe stay as they are, for one */
	previewDocxLockedBlocks_one: "{{count}} paragraph or table can't be edited without changing how it is stored, so it stays as it is.",
	/** Docx editor — as previewDocxLockedBlocks_one, for several */
	previewDocxLockedBlocks_other:
		"{{count}} paragraphs or tables can't be edited without changing how they are stored, so they stay as they are.",
	/** Docx editor — toolbar badge while the cursor is in a part that can't be edited */
	previewDocxLocked: "Can't edit here",
	/** Docx editor — locked part popover title */
	previewDocxLockedTitle: "This part stays as it is",
	/** Docx editor — locked part reason: Word marks the content as locked */
	previewDocxLockedContent: "It's locked in Word.",
	/** Docx editor — locked part reason: editing it here could change how Word stores it */
	previewDocxLockedProof: "Editing it here could change how it's stored, so it's left untouched.",
	/** Docx editor — locked part reason: a structure the editor can't change yet (fields across paragraphs, unusual tables...) */
	previewDocxLockedStructure: "It uses a structure this editor can't change yet.",
	/** Docx editor — toast when saving refuses because the written file did not pass the check; the edits stay open and unsaved, with an action copying the document's text */
	previewDocxSaveRefused:
		"The document couldn't be saved without risking damage to it. It stays open with your changes, unsaved; copy its text to keep them.",
	/** Docx editor — toast when saving an RTF file refuses because it holds a reply to a comment or a resolved comment, which RTF comments cannot have; the edits stay open and unsaved */
	previewDocxSaveRefusedRtfComments:
		"RTF files can't keep replies to comments or resolved comments. Delete the replies and reopen the comments to save, or use Download as to keep them in a Word document.",
	/** Docx editor — toast once an OpenDocument save is stored: the file's older format version (ODF 1.0/1.1) can't mark which text a comment covers, so the comment was saved at the start of that text, for one */
	previewDocxSaveCommentPoint_one:
		"This document's older OpenDocument version can't mark which text a comment covers, so {{count}} comment was saved at the start of its text.",
	/** Docx editor — as previewDocxSaveCommentPoint_one, for several */
	previewDocxSaveCommentPoint_other:
		"This document's older OpenDocument version can't mark which text a comment covers, so {{count}} comments were saved at the start of their text.",
	/** Docx editor — action on the save-refused toast: copies the document's text as edited */
	previewDocxSaveRefusedCopy: "Copy text",
	/** Docx editor — toast once a save is stored: edited parts the save check refused were saved as they were last saved, and went back to that in the editor (undo brings the edits back), for one */
	previewDocxSaveLocked_one:
		"{{count}} paragraph or table couldn't be saved with your latest changes, so it was saved as it was before them and is back to that here. Undo brings your changes back.",
	/** Docx editor — as previewDocxSaveLocked_one, for several */
	previewDocxSaveLocked_other:
		"{{count}} paragraphs or tables couldn't be saved with your latest changes, so they were saved as they were before them and are back to that here. Undo brings your changes back.",
	/** Docx editor — as previewDocxSaveLocked when the editor could not take all of them back (some were edited while the file was stored), for one */
	previewDocxSaveLockedKept_one:
		"{{count}} paragraph or table couldn't be saved with your latest changes, so the file has it as it was before those changes. If you changed it while it saved, your changes are still here, unsaved; otherwise undo brings them back.",
	/** Docx editor — as previewDocxSaveLockedKept_one, for several */
	previewDocxSaveLockedKept_other:
		"{{count}} paragraphs or tables couldn't be saved with your latest changes, so the file has them as they were before those changes. Any you changed while it saved keep your changes here, unsaved; undo brings back the others.",
	/** Docx editor — toast while a save looks for the changes the save check refuses (the editor waits meanwhile) */
	previewDocxSaveSearching: "Checking which changes can be saved…",
	/** Docx editor — notice under the toolbar while autosave is held because the save check refused the document; {{shortcut}} is the save shortcut, e.g. ⌘S */
	previewDocxAutosaveHeld: "Changes aren't being saved automatically: this document needs a save by you. Press {{shortcut}} to save.",
	/** Docx editor — tooltip of the thin bar along the top of the pages while their layout is being redone */
	previewDocxLayoutUpdating: "Laying out pages…",
	/** Docx editor — action on the save-locked toast: copies the text the user had typed into those parts */
	previewDocxSaveLockedCopy: "Copy my changes",
	/** Docx editor — toast when a command that runs in the background (updating fields, inserting a picture) failed */
	previewDocxCommandFailed: "That change couldn't be made.",
	/** Docx editor — ⋯ menu switch: every field shows its code instead of its result (Word's Alt+F9) */
	previewDocxShowFieldCodes: "Show field codes",
	/** Docx editor — context menu item on a field: shows its code instead of its result, or back (Word's Shift+F9) */
	previewDocxToggleFieldCode: "Toggle field code",
	/** Docx editor — screen reader description of the document's editing area: Tab works as in Word instead of moving focus, Escape leaves (from a header, footer or note it first goes back to the body text) */
	previewDocxEditorKeys: "Tab inserts a tab or moves to the next table cell. Press Escape to leave the editor.",
	/** Docx editor — bar above a document Word protects with a password to modify (w:writeProtection): it opens view-only until the password is given */
	previewDocxWritePassword: "This document needs a password to be edited. You can view it without one.",
	/** Docx editor — the same bar when the password uses a hash method the app can't check (e.g. MD5): it stays view-only */
	previewDocxWritePasswordUnsupported:
		"This document needs a password to be edited, and its password can't be checked here, so it can only be viewed.",
	/** Docx editor — bar above a document its author recommends opening read-only (Word's "Read-only recommended"), with no password */
	previewDocxWriteRecommended: "The author recommends opening this document read-only.",
	/** Docx editor — button in that bar: edit the document anyway, as Word offers */
	previewDocxWriteEditAnyway: "Edit anyway",
	/** Docx editor — button in the password bar: asks for the password to modify */
	previewDocxWriteEnterPassword: "Edit…",
	/** Docx editor — title of the prompt for a document's password to modify */
	previewDocxWritePasswordTitle: "Password to edit",
	/** Docx editor — body of that prompt; name is the file's name */
	previewDocxWritePasswordBody: "Enter the password to edit “{{name}}”. The document keeps its password.",
	/** Docx editor — that prompt's submit button and status while the password is checked */
	previewDocxWritePasswordChecking: "Checking…",
	/** Docx editor — under that prompt's field after a wrong password; the document stays view-only */
	previewDocxWritePasswordWrong: "That password isn't right. Try again, or cancel to keep viewing.",
	/** Docx editor — label of the prompt's password field */
	previewDocxWritePasswordLabel: "Password",
	/** Docx editor — submit button of that prompt */
	previewDocxWritePasswordSubmit: "Edit"
} as const
