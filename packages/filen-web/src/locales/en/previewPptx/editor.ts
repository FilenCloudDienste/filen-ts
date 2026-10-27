// "preview" namespace, presentation editor: its File menu, the save state and autosave, the slide list's menu and
// keys, section names, and what it says when a change can't be made. Spread into preview.ts; same catalog rules.
export const previewPptxEditor = {
	/** Slide list — accessible name of the first slide of a section: the section's name, then the slide's own name ({{slide}}, e.g. "Slide 3 of 12") */
	previewPptxEditorSectionStart: "Section {{section}}, {{slide}}",
	/** Presentation editor — the File menu's button, first in the ribbon */
	previewPptxEditorFileMenu: "File",
	/** Presentation editor — File menu item: saves the changes to the file now (also Ctrl+S) */
	previewPptxEditorSave: "Save",
	/** Presentation editor — File menu item: downloads the file as it is saved in the drive */
	previewPptxEditorDownload: "Download",
	/** Presentation editor — File menu checkbox: saves changes by itself a while after the last one (the same setting as Settings → Documents) */
	previewPptxEditorAutosave: "Save automatically",
	/** Presentation editor — under the File menu's autosave checkbox when this presentation is too large to save by itself */
	previewPptxEditorAutosaveOffLarge: "Off for presentations over 256 MB",
	/** Presentation editor — under the File menu's autosave checkbox when this presentation is password-protected and large */
	previewPptxEditorAutosaveOffEncrypted: "Off for password-protected presentations over 64 MB",
	/** Presentation editor — notice strip: why this presentation never saves by itself */
	previewPptxEditorAutosaveOffLargeNotice:
		"This presentation is too large to save automatically. Save your changes with Ctrl+S or File → Save.",
	/** Presentation editor — notice strip: why this password-protected presentation never saves by itself */
	previewPptxEditorAutosaveOffEncryptedNotice:
		"This password-protected presentation is too large to save automatically. Save your changes with Ctrl+S or File → Save.",
	/** Presentation editor — status at the end of the tab row while changes are not saved yet */
	previewPptxEditorUnsaved: "Unsaved changes",
	/** Presentation editor — status at the end of the tab row while the changes are being saved */
	previewPptxEditorSaving: "Saving…",
	/** Presentation editor — badge at the end of the tab row when the presentation can only be viewed */
	previewPptxEditorViewOnly: "View only",
	/** Presentation editor — heading of the popover opened from the "View only" badge */
	previewPptxEditorViewOnlyTitle: "This presentation can only be viewed",
	/** Presentation editor — view-only reason: a PowerPoint 97–2003 (.ppt) file */
	previewPptxEditorViewOnlyLegacy: "It's in the PowerPoint 97–2003 format, which can only be viewed here.",
	/** Toast — a change to the presentation could not be made */
	previewPptxEditorRefused: "That change couldn't be made.",
	/** Toast — a change was refused because the presentation can only be viewed */
	previewPptxEditorRefusedViewOnly: "This presentation can only be viewed, so it can't be changed.",
	/** Toast — a change was refused because what it changes is locked in the file */
	previewPptxEditorRefusedLocked: "That part of the presentation is locked and can't be changed here.",
	/** Toast — a change was refused because editing that kind of content isn't supported yet */
	previewPptxEditorRefusedUnsupported: "Changing this isn't supported here yet.",
	/** Toast — a change was refused because the result would be too large */
	previewPptxEditorRefusedTooLarge: "That change would make the presentation too large.",
	/** Toast — a change was refused because the slide changed meanwhile (another change, a save); trying again works */
	previewPptxEditorRefusedStale: "The presentation changed meanwhile. Try again.",
	/** Toast — after a save: changes that could not be written safely were undone; {{count}} is how many */
	previewPptxEditorSaveReverted_one: "{{count}} change couldn't be saved and was undone.",
	/** Toast — after a save: changes that could not be written safely were undone; {{count}} is how many */
	previewPptxEditorSaveReverted_other: "{{count}} changes couldn't be saved and were undone.",
	/** Toast — after deleting slides: links that went to them now go to the next slide; {{count}} is how many */
	previewPptxEditorJumpsRewritten_one: "{{count}} link to a deleted slide now goes to the next slide.",
	/** Toast — after deleting slides: links that went to them now go to the next slide; {{count}} is how many */
	previewPptxEditorJumpsRewritten_other: "{{count}} links to deleted slides now go to the next slide.",
	/** Slide list menu — adds a slide after the selected one */
	previewPptxEditorMenuNewSlide: "New slide",
	/** Slide list menu — a copy of the selected slides after them */
	previewPptxEditorMenuDuplicate: "Duplicate slide",
	/** Slide list menu — deletes the selected slides */
	previewPptxEditorMenuDelete: "Delete slide",
	/** Slide list menu — hides the selected slides in the slide show */
	previewPptxEditorMenuHide: "Hide slide",
	/** Slide list menu — submenu of the layouts for the selected slides */
	previewPptxEditorMenuLayout: "Layout",
	/** Slide list menu — puts the selected slides' placeholders back as their layout has them */
	previewPptxEditorMenuReset: "Reset slide",
	/** Slide list menu — submenu moving the selected slides */
	previewPptxEditorMenuMove: "Move slide",
	/** Slide list menu → Move slide — to the start of the presentation */
	previewPptxEditorMenuMoveFirst: "To the start",
	/** Slide list menu → Move slide — one place up */
	previewPptxEditorMenuMoveUp: "Up",
	/** Slide list menu → Move slide — one place down */
	previewPptxEditorMenuMoveDown: "Down",
	/** Slide list menu → Move slide — to the end of the presentation */
	previewPptxEditorMenuMoveLast: "To the end",
	/** Slide list menu and Section menu — starts a new section at the selected slide */
	previewPptxEditorAddSection: "Add section",
	/** Slide list menu and Section menu — renames the section the selected slide is in */
	previewPptxEditorRenameSection: "Rename section",
	/** Slide list menu and Section menu — removes the section the selected slide is in (its slides stay, in the section before) */
	previewPptxEditorRemoveSection: "Remove section",
	/** Section dialog — title when adding a section */
	previewPptxEditorAddSectionTitle: "Add section",
	/** Section dialog — title when renaming a section */
	previewPptxEditorRenameSectionTitle: "Rename section",
	/** Section dialog — explanation when adding a section */
	previewPptxEditorAddSectionBody: "The new section starts at the selected slide.",
	/** Section dialog — explanation when renaming a section; {{name}} is its name now */
	previewPptxEditorRenameSectionBody: "Give “{{name}}” a new name.",
	/** Section dialog — label of the section name field */
	previewPptxEditorSectionName: "Section name",
	/** Section dialog — the add button */
	previewPptxEditorSectionAdd: "Add",
	/** Section dialog — the rename button */
	previewPptxEditorSectionRename: "Rename",
	/** The name of the first section when sections are added to a presentation that had none (PowerPoint's own name for it) */
	previewPptxEditorDefaultSection: "Default Section",
	/** The suggested name of a new section */
	previewPptxEditorUntitledSection: "Untitled Section",
	/** Shortcuts list — adds a slide after the current one in the presentation editor */
	previewPptxEditorKeyNewSlide: "New slide (presentations)",
	/** Shortcuts list — duplicates the selected slides in the presentation editor */
	previewPptxEditorKeyDuplicate: "Duplicate slide (presentations)",
	/** Shortcuts list — deletes the selected slides from the slide list of the presentation editor */
	previewPptxEditorKeyDelete: "Delete slide (presentations)",
	/** Shortcuts list — moves the selected slides one place up */
	previewPptxEditorKeyMoveUp: "Move slide up (presentations)",
	/** Shortcuts list — moves the selected slides one place down */
	previewPptxEditorKeyMoveDown: "Move slide down (presentations)",
	/** Shortcuts list — moves the selected slides to the start */
	previewPptxEditorKeyMoveFirst: "Move slide to the start (presentations)",
	/** Shortcuts list — moves the selected slides to the end */
	previewPptxEditorKeyMoveLast: "Move slide to the end (presentations)",
	/** Shortcuts list — undoes the last change in the presentation editor */
	previewPptxEditorKeyUndo: "Undo (presentations)",
	/** Shortcuts list — does again the change last undone in the presentation editor */
	previewPptxEditorKeyRedo: "Redo (presentations)",
	/** Shortcuts list — selects every slide in the slide list of the presentation editor */
	previewPptxEditorKeySelectAll: "Select all slides (presentations)",
	/** Presentation editor — toast when a save is refused because the written file did not pass the check; the edits stay open and unsaved (cf. the document editor's previewDocxSaveRefused) */
	previewPptxSaveRefusedCheck:
		"The presentation couldn't be saved without risking damage to it. It stays open with your changes, unsaved.",
	/** Presentation editor — toast when a save is refused because a change can't be written in the file's format yet */
	previewPptxSaveRefusedUnsupported: "This presentation has a change that can't be saved in this format yet.",
	/** Presentation editor — toast when a save is refused because the file changed on the drive while it saved */
	previewPptxSaveRefusedStale: "The file changed while saving. Try again."
}
