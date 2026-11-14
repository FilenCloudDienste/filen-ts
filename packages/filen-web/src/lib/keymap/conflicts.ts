import { chordIdentity, combosOverlap, formatChord, parseCombo, UNBOUND_COMBO } from "@filen/shared/keymap"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import type { ActionScope } from "@/lib/keymap/registry"

// What the conflict check reads of an action: where it lives and what it is bound to ("" when unbound).
export interface BoundAction {
	readonly id: string
	readonly scope: ActionScope
	readonly combo: string
	readonly overridden?: boolean
}

// Which scopes can have handlers mounted at the same time, as CROSS-scope pairs (a scope always
// co-mounts with itself — see scopesCanCollide). `global` (themeProvider, above the auth gate) and
// `audio` (the player bar runs its useAction calls before its early return) are always mounted.
// drive/notes/chats/photos/contacts/videos are mutually exclusive by route. `editor` co-mounts with drive,
// photos and chats because the preview overlay is hosted by the drive and photos dialog hosts and
// by the chat embeds — it opens ON TOP of those surfaces rather than replacing them — and with notes,
// whose editors bind the editor.* actions.
export const CO_MOUNTABLE: readonly (readonly [ActionScope, ActionScope])[] = [
	["global", "drive"],
	["global", "editor"],
	["global", "notes"],
	["global", "chats"],
	["global", "audio"],
	["global", "photos"],
	["global", "contacts"],
	["global", "videos"],
	["audio", "drive"],
	["audio", "editor"],
	["audio", "notes"],
	["audio", "chats"],
	["audio", "photos"],
	["audio", "contacts"],
	["audio", "videos"],
	["editor", "drive"],
	["editor", "photos"],
	["editor", "chats"],
	["editor", "notes"],
	// Playlists, transfers, sync, mounts and settings are routes of the app shell, under the audio player bar.
	["global", "playlists"],
	["global", "transfers"],
	["global", "sync"],
	["global", "mounts"],
	["global", "settings"],
	["audio", "playlists"],
	["audio", "transfers"],
	["audio", "sync"],
	["audio", "mounts"],
	["audio", "settings"],
	// A public link's page sits outside the app shell (no audio player) and shows a file's preview inline.
	["global", "publicLinks"],
	["editor", "publicLinks"],
	// The players' keys act only with focus inside a player (the Videos player, the preview's video player, the audio
	// bar's controls), which takes them and stops them there: no listing's handler sees them, and the Videos screens sit
	// inert under the Videos player. They share a layer with the shell's keys, the audio transport and the preview
	// overlay's (the preview player is one of its bodies).
	["global", "media"],
	["audio", "media"],
	["media", "editor"]
]

// Collisions that already exist in the shipped defaults and are resolved by an explicit runtime
// guard, not by luck. `drive.download` and `preview.save` share mod+s; the listing's handler checks
// its dialog host's `isDialogOpen`, which is true exactly while the preview overlay is the open
// dialog, so only one of the two ever does real work. The listings' searches and `editor.find` share
// mod+f: the listing handlers ignore editable content and stand down while a dialog is open, the editor
// binds its find inside CodeMirror alone, and the Word document viewer only takes keys pressed in its own
// layer, so focus decides which one runs. `notes.saveNow` and `preview.save` share mod+s only at scope
// level: the preview overlay never mounts on the notes route, so the two never run together.
//
// `conflictingActions` deliberately does not consult it: honoring it in the rebind UI would let a user create a
// SECOND, unguarded mod+s binding and have it silently accepted. The list's conflict marker does, for pairs still on
// their defaults only (conflictsByAction).
export const RESOLVED_COLLISIONS: readonly (readonly [string, string])[] = [
	["drive.download", "preview.save"],
	["drive.search", "editor.find"],
	["photos.search", "editor.find"],
	["notes.saveNow", "preview.save"],
	// The presentation editor's keys act only where focus is: the slide rail (select all slides, delete slides), the
	// slide canvas (select all objects), a body being edited (align left/centre), the running show (its stage and the
	// presenter view stop every key they take), so the listings under the preview (drive, photos, chats), whose
	// handlers stand down while a dialog is open, and the notes route (which never mounts the preview) never see them.
	// Mod+E centres text in a slide body and is editor.code only in the code and Markdown editors, which never mount
	// inside a presentation.
	["presentation.deleteSlide", "drive.trash"],
	["presentation.deleteSlide", "photos.trash"],
	["presentation.deleteSlide", "notes.trash"],
	["presentation.selectAllSlides", "presentation.objects.selectAll"],
	["presentation.selectAllSlides", "drive.selectAll"],
	["presentation.selectAllSlides", "photos.selectAll"],
	["presentation.selectAllSlides", "chats.selectAll"],
	["presentation.selectAllSlides", "notes.selectAll"],
	["presentation.objects.selectAll", "drive.selectAll"],
	["presentation.objects.selectAll", "photos.selectAll"],
	["presentation.objects.selectAll", "chats.selectAll"],
	["presentation.objects.selectAll", "notes.selectAll"],
	["presentation.text.alignCenter", "editor.code"],
	["presentation.text.alignLeft", "presentation.show.laser"],
	// Print over an open deck; the running show takes Mod+P for its pen on its stage and stops it there.
	["office.print", "presentation.show.pen"],
	["presentation.show.arrow", "presentation.selectAllSlides"],
	["presentation.show.arrow", "presentation.objects.selectAll"],
	["presentation.show.arrow", "drive.selectAll"],
	["presentation.show.arrow", "photos.selectAll"],
	["presentation.show.arrow", "chats.selectAll"],
	["presentation.show.arrow", "notes.selectAll"],
	["presentation.show.next", "notes.newNote"],
	["presentation.show.end", "drive.clearSelection"],
	["presentation.show.end", "photos.clearSelection"],
	["presentation.show.end", "chats.clearSelection"],
	["presentation.show.end", "notes.clearSelection"],
	// The image editor and the presentation editor are both bodies of the preview overlay, which shows one file at a
	// time, so their undo and redo are never mounted together.
	["preview.imageUndo", "presentation.undo"],
	["preview.imageRedo", "presentation.redo"],
	// E opens the image on screen in the editor and does nothing over a deck; the running show takes it on its stage.
	["preview.editImage", "presentation.show.eraseAll"],
	// Backspace goes back a slide only in the running show, whose stage and presenter view stop every key they take.
	["presentation.show.previous", "drive.trash"],
	["presentation.show.previous", "photos.trash"],
	["presentation.show.previous", "notes.trash"],
	["presentation.show.previous", "presentation.deleteSlide"],
	// The running show takes Mod+E on its stage and stops it there; editor.code never mounts inside a presentation.
	["presentation.show.eraser", "presentation.text.alignCenter"],
	["presentation.show.eraser", "editor.code"],
	// Paste Formatting takes Mod+Shift+V on the slide and in a body being edited only; editor.togglePreview acts in the
	// Markdown viewer and editors alone, which never mount inside a presentation.
	["presentation.pasteFormat", "editor.togglePreview"],
	// The PDF viewer and the presentation editor are both bodies of the preview overlay, which shows one file at a time,
	// and each matches these keys on its own keydown only.
	["preview.pdfZoomIn", "presentation.zoomIn"],
	["preview.pdfZoomOut", "presentation.zoomOut"],
	["preview.pdfRotateCw", "presentation.objects.bringForward"],
	["preview.pdfRotateCcw", "presentation.objects.sendBackward"],
	// Off a Mac, subscript's Mod+Ctrl+= and superscript's Mod+Ctrl+Shift+= are Ctrl+= and Ctrl+Shift+=, zoom in's keys
	// (PowerPoint's, both). Subscript and superscript act in a body being edited and on shapes selected on the slide,
	// which take the key first and stop it; zoom acts only outside text, on the editor's own keydown. The PDF viewer
	// never shows with a presentation.
	["presentation.text.subscript", "presentation.zoomIn"],
	["presentation.text.superscript", "presentation.zoomIn"],
	["presentation.text.subscript", "preview.pdfZoomIn"],
	["presentation.text.superscript", "preview.pdfZoomIn"],
	// On a Mac, promote and demote are Cmd+[ and Cmd+] (PowerPoint for Mac's), the keys of the object order and the PDF
	// rotation. They act in a body being edited only, which takes the key first; the object order acts on shapes
	// selected on the slide, the rotation in the PDF viewer, which never shows with a presentation.
	["presentation.text.promote", "presentation.objects.sendBackward"],
	["presentation.text.demote", "presentation.objects.bringForward"],
	["presentation.text.promote", "preview.pdfRotateCcw"],
	["presentation.text.demote", "preview.pdfRotateCw"],
	// The shell's sidebar toggle and the desktop app's back and forward stand down while a dialog is open, and the PDF
	// viewer and the presentation editor are bodies of the preview dialog.
	["app.toggleSidebar", "preview.pdfToggleFit"],
	["desktop.back", "preview.pdfRotateCcw"],
	["desktop.back", "presentation.objects.sendBackward"],
	["desktop.back", "presentation.text.promote"],
	["desktop.forward", "preview.pdfRotateCw"],
	["desktop.forward", "presentation.objects.bringForward"],
	["desktop.forward", "presentation.text.demote"],
	// The desktop app's window zoom takes only the zoom keys a document viewer left alone: the PDF viewer and the
	// presentation editor zoom themselves on these keys and cancel them, as subscript does in a slide's text.
	["desktop.zoomIn", "preview.pdfZoomIn"],
	["desktop.zoomIn", "presentation.zoomIn"],
	["desktop.zoomIn", "presentation.text.subscript"],
	["desktop.zoomOut", "preview.pdfZoomOut"],
	["desktop.zoomOut", "presentation.zoomOut"],
	["desktop.zoomReset", "preview.pdfZoomReset"],
	// The listings' own keys under the preview overlay. Open and the item menu listen on the listbox alone, the others
	// stand down while a dialog is open, which the preview is; the slide list, the running show and the editors take
	// their keys in the preview only. Photos' Mod+S is drive's.
	["photos.download", "preview.save"],
	["drive.open", "presentation.show.next"],
	["photos.open", "presentation.show.next"],
	["drive.open", "presentation.moveSlideDown"],
	["photos.open", "presentation.moveSlideDown"],
	["drive.goUp", "presentation.moveSlideUp"],
	["drive.info", "editor.italic"],
	["photos.info", "editor.italic"],
	["drive.openContainingDirectory", "presentation.text.lineBreak"],
	["drive.refresh", "presentation.show.start"],
	["drive.refresh", "presentation.text.alignRight"],
	// The notes route never mounts the preview overlay, so the image editor's and the presentation's keys never run there.
	["notes.duplicate", "presentation.duplicateSlide"],
	["notes.archive", "preview.editImage"],
	["notes.archive", "presentation.show.eraseAll"],
	["notes.pin", "presentation.show.previous"],
	// The notes search ignores editable content; a note's editor binds its own find inside CodeMirror alone.
	["notes.search", "editor.find"],
	// Escape cancels a reply or edit in the message field only; clearing the conversation selection ignores fields.
	["chats.clearSelection", "chats.composer.cancel"],
	// Delete acts in the conversation list for conversations and on a focused message for messages: both ref-scoped.
	["chats.deleteSelected", "chats.message.delete"],
	// The chat list, thread and message field stand down under the preview dialog its embeds open, and the running
	// show and the presentation editor take these keys on their own stage, slide or text body first.
	["chats.newChat", "presentation.show.next"],
	["chats.composer.send", "presentation.show.next"],
	["chats.composer.editLast", "presentation.show.previous"],
	["chats.composer.cancel", "presentation.show.end"],
	["chats.composer.newline", "presentation.text.lineBreak"],
	["chats.composer.inlineCode", "presentation.text.alignCenter"],
	["chats.composer.inlineCode", "presentation.show.eraser"],
	["chats.deleteSelected", "presentation.deleteSlide"],
	["chats.deleteSelected", "presentation.show.previous"],
	["chats.message.delete", "presentation.deleteSlide"],
	["chats.message.delete", "presentation.show.previous"],
	["chats.message.edit", "presentation.show.eraseAll"],
	["chats.jumpToLatest", "presentation.show.last"],
	["chats.jumpToOldest", "presentation.show.first"],
	["chats.nextUnread", "presentation.text.moveParagraphDown"],
	["chats.previousUnread", "presentation.text.moveParagraphUp"],
	// The editors' own find and inline code act in the code and Markdown editors, which never take focus in the chat
	// page; the chat search ignores editable content and the composer matches Mod+E in its own field.
	["chats.search", "editor.find"],
	["chats.composer.inlineCode", "editor.code"],
	// E edits the focused message in the thread; it opens an image in the editor only inside the preview dialog.
	["chats.message.edit", "preview.editImage"],
	// A shared link's inline preview is read-only and never mounts the preview overlay, where alone preview.save binds.
	["links.download", "preview.save"],
	// A slideshow run from a shared link's inline preview stops every key its stage takes, Escape included.
	["links.back", "presentation.show.end"],
	// The players' keys act only with focus inside a player, which takes them and stops them there: the Videos player,
	// a modal layer that leaves the app behind it inert (Escape closes it, as every dialog); the preview's video player,
	// one body of the preview overlay, which never shows it with a slideshow or an image; the audio bar's own controls.
	// A running slideshow takes its keys on its own stage, which no player shares.
	["media.close", "presentation.show.end"],
	["media.episodes", "preview.editImage"],
	["media.episodes", "presentation.show.eraseAll"],
	["media.frameForward", "presentation.show.black"],
	["media.frameBack", "presentation.show.white"],
	["media.toStart", "presentation.show.first"],
	["media.toEnd", "presentation.show.last"],
	["media.chapterNext", "presentation.show.next"],
	["media.playPause", "presentation.show.next"],
	["media.seekForward", "presentation.show.next"],
	["media.volumeDown", "presentation.show.next"],
	["media.subtitleLater", "presentation.show.nextHidden"],
	["media.chapterPrevious", "presentation.show.previous"],
	["media.seekBack", "presentation.show.previous"],
	["media.volumeUp", "presentation.show.previous"],
	["media.audioTrack", "presentation.show.togglePointer"],
	["media.normalSpeed", "presentation.show.togglePointer"],
	// Off a Mac, the audio transport's Alt+Shift arrows are the outline keys of a slide body being edited: an editable
	// text element, where the transport never fires.
	["audio.seekBack", "presentation.text.promote"],
	["audio.seekForward", "presentation.text.demote"],
	// The preview overlay's own keys take a key pressed in its layer only, never one something inside took (a viewer's
	// own, the archive list's, the running show's) nor one in a field or an editing surface; the listings under it
	// (drive, photos, chats) and the notes route (which never mounts it) stand down while a dialog is open.
	["preview.close", "drive.clearSelection"],
	["preview.close", "photos.clearSelection"],
	["preview.close", "chats.clearSelection"],
	["preview.close", "notes.clearSelection"],
	["preview.close", "presentation.show.end"],
	["preview.download", "drive.download"],
	["preview.download", "notes.saveNow"],
	["preview.download", "preview.save"],
	["preview.rename", "drive.rename"],
	["preview.trash", "drive.trash"],
	["preview.trash", "photos.trash"],
	["preview.trash", "notes.trash"],
	["preview.trash", "presentation.deleteSlide"],
	["preview.info", "editor.italic"],
	["preview.first", "presentation.show.first"],
	["preview.last", "presentation.show.last"],
	["preview.prev", "presentation.show.previous"],
	["preview.next", "presentation.show.next"],
	// One body shows at a time (image viewer or editor, PDF, code, presentation, archive), and each matches these on its
	// own keydown or in its own editor only. The image editor replaces the viewer; a zoomed-in image takes the arrows
	// ahead of the pager, which pages again at fit.
	["preview.imageCancel", "preview.close"],
	["preview.imageCancel", "drive.clearSelection"],
	["preview.imageCancel", "photos.clearSelection"],
	["preview.imageCancel", "chats.clearSelection"],
	["preview.imageCancel", "notes.clearSelection"],
	["preview.imageCancel", "presentation.show.end"],
	["preview.imagePanLeft", "preview.prev"],
	["preview.imagePanRight", "preview.next"],
	["preview.imagePanLeft", "presentation.show.previous"],
	["preview.imagePanUp", "presentation.show.previous"],
	["preview.imagePanRight", "presentation.show.next"],
	["preview.imagePanDown", "presentation.show.next"],
	["preview.imageActualSize", "preview.imageTabAdjust"],
	["preview.imageZoomIn", "preview.pdfZoomIn"],
	["preview.imageZoomOut", "preview.pdfZoomOut"],
	["preview.imageZoomFit", "preview.pdfZoomReset"],
	["preview.imageZoomIn", "presentation.zoomIn"],
	["preview.imageZoomOut", "presentation.zoomOut"],
	["preview.imageZoomIn", "presentation.text.subscript"],
	["preview.imageZoomIn", "presentation.text.superscript"],
	["preview.imageRotateLeft", "preview.pdfRotateCcw"],
	["preview.imageRotateRight", "preview.pdfRotateCw"],
	["preview.imageRotateLeft", "presentation.objects.sendBackward"],
	["preview.imageRotateRight", "presentation.objects.bringForward"],
	["preview.imageRotateLeft", "presentation.text.promote"],
	["preview.imageRotateRight", "presentation.text.demote"],
	["preview.pdfNextPage", "presentation.show.next"],
	["preview.pdfPreviousPage", "presentation.show.previous"],
	["preview.pdfNextPage", "notes.newNote"],
	["editor.undo", "preview.imageUndo"],
	["editor.undo", "presentation.undo"],
	["editor.redo", "preview.imageRedo"],
	["editor.redo", "presentation.redo"],
	["editor.goToLine", "preview.pdfGoToPage"],
	["editor.findNext", "presentation.objects.group"],
	["editor.findPrevious", "presentation.objects.ungroup"],
	["editor.fold", "presentation.objects.sendToBack"],
	["editor.unfold", "presentation.objects.bringToFront"],
	["editor.fontSizeIncrease", "preview.pdfZoomIn"],
	["editor.fontSizeIncrease", "preview.imageZoomIn"],
	["editor.fontSizeIncrease", "presentation.zoomIn"],
	["editor.fontSizeIncrease", "presentation.text.subscript"],
	["editor.fontSizeIncrease", "presentation.text.superscript"],
	["editor.fontSizeDecrease", "preview.pdfZoomOut"],
	["editor.fontSizeDecrease", "preview.imageZoomOut"],
	["editor.fontSizeDecrease", "presentation.zoomOut"],
	["editor.fontSizeReset", "preview.pdfZoomReset"],
	["editor.fontSizeReset", "preview.imageZoomFit"],
	// The archive browser takes its keys with its list focused and stops them, and a file opened from it takes its back
	// key in its own subtree; Escape clears the list's selection only while there is one.
	["archive.back", "preview.close"],
	["archive.back", "archive.clearSelection"],
	["archive.back", "preview.imageCancel"],
	["archive.back", "drive.clearSelection"],
	["archive.back", "photos.clearSelection"],
	["archive.back", "chats.clearSelection"],
	["archive.back", "notes.clearSelection"],
	["archive.back", "presentation.show.end"],
	["archive.back", "preview.pdfRotateCcw"],
	["archive.back", "preview.imageRotateLeft"],
	["archive.back", "presentation.objects.sendBackward"],
	["archive.back", "presentation.text.promote"],
	["archive.clearSelection", "preview.close"],
	["archive.clearSelection", "preview.imageCancel"],
	["archive.clearSelection", "drive.clearSelection"],
	["archive.clearSelection", "photos.clearSelection"],
	["archive.clearSelection", "chats.clearSelection"],
	["archive.clearSelection", "notes.clearSelection"],
	["archive.clearSelection", "presentation.show.end"],
	["archive.download", "preview.download"],
	["archive.download", "preview.save"],
	["archive.download", "drive.download"],
	["archive.download", "notes.saveNow"],
	["archive.openMenu", "preview.openMenu"],
	["archive.open", "presentation.show.next"],
	["archive.open", "presentation.moveSlideDown"],
	["archive.toggle", "presentation.show.next"],
	["archive.parent", "drive.trash"],
	["archive.parent", "photos.trash"],
	["archive.parent", "notes.trash"],
	["archive.parent", "presentation.deleteSlide"],
	["archive.parent", "presentation.moveSlideUp"],
	["archive.parent", "presentation.show.previous"],
	// The Word editor is a body of the preview overlay too, shown alone, and takes its keys in its own layer: the code
	// and Markdown editors, the PDF viewer, the image editor and the presentation editor and show never show with it.
	// It binds Word's Find and Replace (docx.replace), not editor.replace, whose Mod+Alt+F is Word's footnote.
	["docx.alignCenter", "editor.code"],
	["docx.insertFootnote", "editor.replace"],
	["docx.pasteFormatting", "editor.togglePreview"],
	["docx.strikethrough", "editor.strikethrough"],
	["docx.superscript", "preview.pdfZoomIn"],
	["docx.zoomIn", "preview.pdfZoomIn"],
	["docx.zoomOut", "preview.pdfZoomOut"],
	["docx.zoomReset", "preview.pdfZoomReset"],
	["docx.growFontPoint", "preview.pdfRotateCw"],
	["docx.shrinkFontPoint", "preview.pdfRotateCcw"],
	["docx.undo", "preview.imageUndo"],
	["docx.redo", "preview.imageRedo"],
	["docx.undo", "presentation.undo"],
	["docx.redo", "presentation.redo"],
	["docx.replace", "presentation.show.hidePointer"],
	["docx.goTo", "presentation.objects.group"],
	["docx.underline", "presentation.text.underline"],
	["docx.doubleUnderline", "presentation.duplicateSlide"],
	["docx.superscript", "presentation.zoomIn"],
	["docx.superscript", "presentation.text.superscript"],
	["docx.clearFormatting", "presentation.text.clearFormatting"],
	["docx.growFont", "presentation.text.growFont"],
	["docx.shrinkFont", "presentation.text.shrinkFont"],
	["docx.growFontPoint", "presentation.objects.bringForward"],
	["docx.growFontPoint", "presentation.text.demote"],
	["docx.shrinkFontPoint", "presentation.objects.sendBackward"],
	["docx.shrinkFontPoint", "presentation.text.promote"],
	["docx.alignLeft", "presentation.text.alignLeft"],
	["docx.alignLeft", "presentation.show.laser"],
	["docx.alignCenter", "presentation.text.alignCenter"],
	["docx.alignCenter", "presentation.show.eraser"],
	["docx.alignRight", "presentation.text.alignRight"],
	["docx.justify", "presentation.text.justify"],
	["docx.indent", "presentation.newSlide"],
	["docx.insertPageBreak", "presentation.text.nextPlaceholder"],
	["docx.copyFormatting", "presentation.copyFormat"],
	["docx.pasteFormatting", "presentation.pasteFormat"],
	["docx.wordCount", "presentation.objects.ungroup"],
	["docx.downloadPdf", "office.print"],
	["docx.downloadPdf", "presentation.show.pen"],
	["docx.zoomIn", "presentation.zoomIn"],
	["docx.zoomIn", "presentation.text.subscript"],
	["docx.zoomOut", "presentation.zoomOut"],
	// The spreadsheet grid matches its keys on its own keydown, in the sheet alone (its cells, its cell editor, and its
	// layer for the workbook's own: find, print, go to). The sheet is a body of the preview overlay, which shows one file
	// at a time, so the PDF viewer's, the image editor's, the presentation editor's and the running show's keys never
	// mount with it; the code and Markdown editors' (editor.*) bind inside CodeMirror, which no sheet holds, and the Word
	// viewer's find acts in its own layer; the listings under the overlay (drive, photos, chats) stand down while a
	// dialog is open, and the notes route never mounts the overlay.
	["sheet.selectAll", "drive.selectAll"],
	["sheet.selectAll", "photos.selectAll"],
	["sheet.selectAll", "chats.selectAll"],
	["sheet.selectAll", "notes.selectAll"],
	["sheet.selectAll", "presentation.selectAllSlides"],
	["sheet.selectAll", "presentation.objects.selectAll"],
	["sheet.selectAll", "presentation.show.arrow"],
	["sheet.find", "drive.search"],
	["sheet.find", "photos.search"],
	["sheet.find", "editor.find"],
	["sheet.find", "presentation.show.startCurrent"],
	["sheet.bold", "editor.bold"],
	["sheet.italic", "editor.italic"],
	["sheet.strikethrough", "editor.strikethrough"],
	["sheet.hyperlink", "editor.link"],
	["sheet.pasteValues", "editor.togglePreview"],
	["sheet.pasteValues", "presentation.pasteFormat"],
	["sheet.undo", "preview.imageUndo"],
	["sheet.undo", "presentation.undo"],
	["sheet.redo", "preview.imageRedo"],
	["sheet.redo", "presentation.redo"],
	["sheet.redoOrRepeat", "preview.imageRedo"],
	["sheet.redoOrRepeat", "presentation.redo"],
	["sheet.insertCells", "preview.pdfZoomIn"],
	["sheet.insertCells", "presentation.zoomIn"],
	["sheet.insertCells", "presentation.text.superscript"],
	["sheet.deleteCells", "preview.pdfZoomOut"],
	["sheet.deleteCells", "presentation.zoomOut"],
	["sheet.hideColumns", "preview.pdfZoomReset"],
	["sheet.fillDown", "presentation.duplicateSlide"],
	["sheet.fillRight", "presentation.text.alignRight"],
	["sheet.underline", "presentation.text.underline"],
	["sheet.fontGrow", "presentation.text.growFont"],
	["sheet.fontShrink", "presentation.text.shrinkFont"],
	["sheet.selectColumns", "presentation.text.clearFormatting"],
	["sheet.goTo", "presentation.objects.group"],
	["sheet.goTo", "presentation.show.start"],
	["sheet.replace", "presentation.show.hidePointer"],
	// Mod+D duplicates the objects selected on the slide, whose canvas takes it first and stops it, and the slides in
	// the slide list, whose own keydown takes it there (PowerPoint's both).
	["presentation.objects.duplicate", "presentation.duplicateSlide"],
	// The running show takes Mod+I for its highlighter on its stage and stops it there; italic acts in the editors.
	["presentation.show.highlighter", "editor.italic"],
	// The listings' keys, the shell's route, pane and sidebar keys and the desktop app's back and forward stand down while
	// a dialog is open (OUTSIDE_OVERLAYS), and the preview overlay is one: its bodies (the viewers, the Word, spreadsheet
	// and presentation editors, the archive browser) take these keys only inside it. The notes route never mounts it.
	["app.nextPane", "sheet.nextPane"],
	["app.openChats", "sheet.italic"],
	["app.openContacts", "sheet.underline"],
	["app.openDrive", "docx.lineSpacingSingle"],
	["app.openDrive", "sheet.formatCells"],
	["app.openNotes", "docx.lineSpacingDouble"],
	["app.openNotes", "sheet.bold"],
	["app.openSync", "docx.lineSpacingOneAndHalf"],
	["app.openSync", "sheet.strikethrough"],
	["app.previousPane", "sheet.previousPane"],
	["chats.deleteSelected", "archive.parent"],
	["chats.deleteSelected", "preview.trash"],
	["chats.jumpToLatest", "preview.last"],
	["chats.jumpToOldest", "preview.first"],
	["chats.message.delete", "archive.parent"],
	["chats.message.delete", "preview.trash"],
	["chats.message.menu", "archive.openMenu"],
	["chats.message.menu", "preview.openMenu"],
	["chats.message.menu", "sheet.contextMenu"],
	["chats.newChat", "preview.pdfNextPage"],
	["chats.nextChat", "sheet.openDropdown"],
	["chats.previousChat", "archive.parent"],
	["chats.rename", "preview.rename"],
	["chats.search", "sheet.find"],
	["desktop.back", "archive.back"],
	["desktop.back", "docx.shrinkFontPoint"],
	["desktop.back", "preview.imageRotateLeft"],
	["desktop.forward", "docx.growFontPoint"],
	["desktop.forward", "preview.imageRotateRight"],
	["drive.copyLink", "editor.findMatchCase"],
	["drive.downloadAs", "preview.imageSaveCopy"],
	["drive.downloadAs", "sheet.saveAs"],
	["drive.goUp", "archive.parent"],
	["drive.info", "presentation.show.highlighter"],
	["drive.info", "preview.info"],
	["drive.info", "sheet.italic"],
	["drive.open", "archive.open"],
	["drive.openItemMenu", "archive.openMenu"],
	["drive.openItemMenu", "preview.openMenu"],
	["drive.openItemMenu", "sheet.contextMenu"],
	["drive.refresh", "docx.alignRight"],
	["drive.refresh", "sheet.fillRight"],
	["drive.refresh", "sheet.goTo"],
	["drive.newDirectory", "docx.styleNormal"],
	["drive.restore", "preview.trash"],
	["drive.restore", "sheet.revealActive"],
	["drive.toggleHiddenItems", "docx.growFont"],
	["drive.toggleHiddenItems", "presentation.text.growFont"],
	["drive.toggleHiddenItems", "sheet.fontGrow"],
	["notes.duplicate", "docx.doubleUnderline"],
	["notes.favorite", "preview.pdfFullScreen"],
	["notes.pin", "preview.pdfPreviousPage"],
	["notes.rename", "preview.rename"],
	["notes.search", "sheet.find"],
	["notes.trash", "sheet.revealActive"],
	["photos.download", "archive.download"],
	["photos.download", "preview.download"],
	["photos.info", "presentation.show.highlighter"],
	["photos.info", "preview.info"],
	["photos.info", "sheet.italic"],
	["photos.open", "archive.open"],
	["photos.openItemMenu", "archive.openMenu"],
	["photos.openItemMenu", "preview.openMenu"],
	["photos.openItemMenu", "sheet.contextMenu"],
	["photos.rename", "preview.rename"],
	// The video editor replaces the preview's body (one file shows at a time) and matches its keys on its own keydown and
	// in its layer only, never in a text field: no other body (image viewer or editor, PDF, code, document, presentation,
	// archive) is mounted with it, the overlay's own pager, close and item keys stand down while it is open, and Escape
	// leaves it through the overlay's dismissal.
	["preview.videoCancel", "archive.back"],
	["preview.videoCancel", "archive.clearSelection"],
	["preview.videoCancel", "presentation.show.end"],
	["preview.videoCancel", "preview.close"],
	["preview.videoCancel", "preview.imageCancel"],
	["preview.videoFrameBack", "presentation.show.previous"],
	["preview.videoFrameBack", "preview.imagePanLeft"],
	["preview.videoFrameBack", "preview.prev"],
	["preview.videoFrameForward", "presentation.show.next"],
	["preview.videoFrameForward", "preview.imagePanRight"],
	["preview.videoFrameForward", "preview.next"],
	["preview.videoPlayPause", "archive.toggle"],
	["preview.videoPlayPause", "presentation.show.next"],
	["preview.videoRedo", "docx.redo"],
	["preview.videoRedo", "editor.redo"],
	["preview.videoRedo", "presentation.redo"],
	["preview.videoRedo", "preview.imageRedo"],
	["preview.videoRedo", "sheet.redo"],
	["preview.videoRedo", "sheet.redoOrRepeat"],
	["preview.videoRemoveSection", "archive.parent"],
	["preview.videoRemoveSection", "presentation.deleteSlide"],
	["preview.videoRemoveSection", "presentation.show.previous"],
	["preview.videoRemoveSection", "preview.trash"],
	["preview.videoSaveCopy", "preview.imageSaveCopy"],
	["preview.videoSaveCopy", "sheet.saveAs"],
	["preview.videoToEnd", "presentation.show.last"],
	["preview.videoToEnd", "preview.last"],
	["preview.videoToStart", "presentation.show.first"],
	["preview.videoToStart", "preview.first"],
	["preview.videoUndo", "docx.undo"],
	["preview.videoUndo", "editor.undo"],
	["preview.videoUndo", "presentation.undo"],
	["preview.videoUndo", "preview.imageUndo"],
	["preview.videoUndo", "sheet.undo"],
	["preview.videoZoomFit", "docx.zoomReset"],
	["preview.videoZoomFit", "editor.fontSizeReset"],
	["preview.videoZoomFit", "preview.imageZoomFit"],
	["preview.videoZoomFit", "preview.pdfZoomReset"],
	["preview.videoZoomFit", "sheet.hideColumns"],
	["preview.videoZoomIn", "docx.superscript"],
	["preview.videoZoomIn", "docx.zoomIn"],
	["preview.videoZoomIn", "editor.fontSizeIncrease"],
	["preview.videoZoomIn", "presentation.text.subscript"],
	["preview.videoZoomIn", "presentation.text.superscript"],
	["preview.videoZoomIn", "presentation.zoomIn"],
	["preview.videoZoomIn", "preview.imageZoomIn"],
	["preview.videoZoomIn", "preview.pdfZoomIn"],
	["preview.videoZoomIn", "sheet.insertCells"],
	["preview.videoZoomOut", "docx.zoomOut"],
	["preview.videoZoomOut", "editor.fontSizeDecrease"],
	["preview.videoZoomOut", "presentation.zoomOut"],
	["preview.videoZoomOut", "preview.imageZoomOut"],
	["preview.videoZoomOut", "preview.pdfZoomOut"],
	["preview.videoZoomOut", "sheet.deleteCells"],
	// The listings and the chat under the preview stand down while it is the open dialog; a public link's page shows no
	// editor.
	["preview.videoCancel", "chats.clearSelection"],
	["preview.videoCancel", "chats.composer.cancel"],
	["preview.videoCancel", "drive.clearSelection"],
	["preview.videoCancel", "links.back"],
	["preview.videoCancel", "notes.clearSelection"],
	["preview.videoCancel", "photos.clearSelection"],
	["preview.videoRemoveSection", "chats.deleteSelected"],
	["preview.videoRemoveSection", "chats.message.delete"],
	["preview.videoRemoveSection", "drive.trash"],
	["preview.videoRemoveSection", "notes.trash"],
	["preview.videoRemoveSection", "photos.trash"],
	["preview.videoSaveCopy", "drive.downloadAs"],
	["preview.videoSaveCopy", "links.saveToDrive"],
	["preview.videoToEnd", "chats.jumpToLatest"],
	["preview.videoToStart", "chats.jumpToOldest"],
	// The editor's stage is no player: it mounts none of the players' keys (which act only with focus inside a player).
	["preview.videoCancel", "media.close"],
	["preview.videoFrameBack", "media.seekBack"],
	["preview.videoFrameForward", "media.seekForward"],
	["preview.videoPlayPause", "media.playPause"],
	["preview.videoSecondBack", "media.seekBackLong"],
	["preview.videoSecondForward", "media.seekForwardLong"],
	["preview.videoSetIn", "media.pictureInPicture"],
	["preview.videoShuttleBack", "media.seekBack"],
	["preview.videoShuttleForward", "media.seekForward"],
	["preview.videoShuttlePause", "media.playPause"],
	["preview.videoSplit", "media.skip"],
	["preview.videoToEnd", "media.toEnd"],
	["preview.videoToStart", "media.toStart"],
	// Off a Mac the desktop app's window zoom takes only a zoom key no document took: the timeline zoom cancels it first.
	["preview.videoZoomFit", "desktop.zoomReset"],
	["preview.videoZoomIn", "desktop.zoomIn"],
	["preview.videoZoomOut", "desktop.zoomOut"],
	// Off a Mac the desktop app's window zoom takes only a zoom key no document took: the viewers and editors that zoom
	// (or, in the spreadsheet, insert, delete and hide on these keys) cancel it first.
	["desktop.zoomIn", "docx.zoomIn"],
	["desktop.zoomIn", "editor.fontSizeIncrease"],
	["desktop.zoomIn", "preview.imageZoomIn"],
	["desktop.zoomOut", "docx.zoomOut"],
	["desktop.zoomOut", "editor.fontSizeDecrease"],
	["desktop.zoomOut", "preview.imageZoomOut"],
	["desktop.zoomOut", "sheet.deleteCells"],
	["desktop.zoomReset", "docx.zoomReset"],
	["desktop.zoomReset", "editor.fontSizeReset"],
	["desktop.zoomReset", "preview.imageZoomFit"],
	["desktop.zoomReset", "sheet.hideColumns"],
	// The desktop app's lock stands down for a key a document took: in the spreadsheet's grid, Mod+Alt+L is Excel's Reapply.
	["app.lock", "sheet.reapplyFilter"],
	// The chat composer's keys act in its own field, which the preview overlay's layer never holds.
	["chats.composer.cancel", "archive.back"],
	["chats.composer.cancel", "archive.clearSelection"],
	["chats.composer.cancel", "preview.close"],
	["chats.composer.cancel", "preview.imageCancel"],
	["chats.composer.editLast", "preview.imagePanUp"],
	["chats.composer.inlineCode", "docx.alignCenter"],
	["chats.composer.send", "archive.open"],
	// The players' keys act only with focus inside a player, which takes them and stops them there: no image, document or
	// archive body shares a layer with one, and the preview's pager steps only on a key the player left.
	["media.close", "archive.back"],
	["media.close", "archive.clearSelection"],
	["media.close", "preview.close"],
	["media.close", "preview.imageCancel"],
	["media.fullscreen", "preview.pdfFullScreen"],
	["media.jump.forty", "preview.imageTabMarkup"],
	["media.jump.ten", "preview.imageActualSize"],
	["media.jump.ten", "preview.imageTabAdjust"],
	["media.jump.thirty", "preview.imageTabFilters"],
	["media.jump.twenty", "preview.imageTabCrop"],
	["media.playPause", "archive.toggle"],
	["media.seekBack", "preview.imagePanLeft"],
	["media.seekBack", "preview.prev"],
	["media.seekForward", "preview.imagePanRight"],
	["media.seekForward", "preview.next"],
	["media.toEnd", "preview.last"],
	["media.toStart", "preview.first"],
	["media.volumeDown", "preview.imagePanDown"],
	["media.volumeUp", "preview.imagePanUp"],
	// A shared link's page never mounts the preview overlay; its inline preview is read-only (no image editor, no copy of
	// a workbook), and its archive browser takes the keys pressed in it and stops them.
	["links.back", "archive.back"],
	["links.back", "archive.clearSelection"],
	["links.back", "preview.close"],
	["links.back", "preview.imageCancel"],
	["links.download", "archive.download"],
	["links.download", "preview.download"],
	["links.filter", "archive.search"],
	["links.saveToDrive", "preview.imageSaveCopy"],
	["links.saveToDrive", "sheet.saveAs"],
	["links.up", "archive.parent"],
	// The preview overlay's own keys take only a key no body took: the grid's italic, menu and reveal keys, the running
	// show's highlighter.
	["preview.info", "presentation.show.highlighter"],
	["preview.info", "sheet.italic"],
	["preview.openMenu", "sheet.contextMenu"],
	["preview.trash", "sheet.revealActive"],
	// The preview overlay shows one file at a time, so its bodies' keys (the viewers', the code editor's, the Word
	// editor's, the spreadsheet's, the presentation's, the archive browser's) are never mounted together.
	["archive.back", "docx.shrinkFontPoint"],
	["archive.openMenu", "sheet.contextMenu"],
	["docx.alignRight", "sheet.fillRight"],
	["docx.bulletList", "sheet.filter"],
	["docx.changeCase", "editor.findPrevious"],
	["docx.changeCase", "sheet.find"],
	["docx.clearFormatting", "sheet.selectColumns"],
	["docx.formattingMarks", "sheet.selectRegion"],
	["docx.goTo", "editor.findNext"],
	["docx.goTo", "editor.goToLine"],
	["docx.goTo", "preview.pdfGoToPage"],
	["docx.goTo", "sheet.goTo"],
	["docx.growFont", "sheet.fontGrow"],
	["docx.growFontPoint", "preview.imageRotateRight"],
	["docx.insertEquation", "sheet.autoSum"],
	["docx.insertPageBreak", "presentation.show.startCurrent"],
	["docx.lineSpacingDouble", "sheet.bold"],
	["docx.lineSpacingOneAndHalf", "sheet.strikethrough"],
	["docx.lineSpacingSingle", "sheet.formatCells"],
	["docx.newComment", "sheet.newComment"],
	["docx.numberedList", "sheet.borderOutline"],
	["docx.pasteFormatting", "sheet.pasteValues"],
	["docx.redo", "editor.redo"],
	["docx.redo", "sheet.redo"],
	["docx.redo", "sheet.redoOrRepeat"],
	["docx.repeat", "sheet.repeat"],
	["docx.replace", "sheet.replace"],
	["docx.shrinkFont", "sheet.fontShrink"],
	["docx.shrinkFontPoint", "preview.imageRotateLeft"],
	["docx.strikethrough", "sheet.strikethrough"],
	["docx.styleNormal", "sheet.borderOutline"],
	["docx.styleNormal", "sheet.zoomReset"],
	["docx.subscript", "sheet.borderNone"],
	["docx.superscript", "editor.fontSizeIncrease"],
	["docx.superscript", "preview.imageZoomIn"],
	["docx.superscript", "sheet.insertCells"],
	["docx.underline", "sheet.underline"],
	["docx.undo", "editor.undo"],
	["docx.undo", "sheet.undo"],
	["docx.unhang", "sheet.autoSum"],
	["docx.wordCount", "editor.findPrevious"],
	["docx.zoomIn", "editor.fontSizeIncrease"],
	["docx.zoomIn", "preview.imageZoomIn"],
	["docx.zoomIn", "sheet.insertCells"],
	["docx.zoomOut", "editor.fontSizeDecrease"],
	["docx.zoomOut", "preview.imageZoomOut"],
	["docx.zoomOut", "sheet.deleteCells"],
	["docx.zoomReset", "editor.fontSizeReset"],
	["docx.zoomReset", "preview.imageZoomFit"],
	["docx.zoomReset", "sheet.hideColumns"],
	["editor.findNext", "sheet.goTo"],
	["editor.findPrevious", "sheet.find"],
	["editor.fontSizeDecrease", "sheet.deleteCells"],
	["editor.fontSizeIncrease", "sheet.insertCells"],
	["editor.fontSizeReset", "sheet.hideColumns"],
	["editor.redo", "sheet.redo"],
	["editor.redo", "sheet.redoOrRepeat"],
	["editor.undo", "sheet.undo"],
	["presentation.objects.bringForward", "sheet.filter"],
	["presentation.objects.duplicate", "sheet.fillDown"],
	["presentation.show.highlighter", "sheet.italic"],
	["preview.imageSaveCopy", "sheet.saveAs"],
	["preview.imageZoomFit", "sheet.hideColumns"],
	["preview.imageZoomIn", "sheet.insertCells"],
	["preview.imageZoomOut", "sheet.deleteCells"],
	["preview.pdfNextPage", "sheet.nextSheet"],
	["preview.pdfPreviousPage", "sheet.previousSheet"]
]

export function scopesCanCollide(a: ActionScope, b: ActionScope): boolean {
	// A scope always co-mounts with itself — binding drive.rename to mod+a while drive.selectAll holds
	// it is by far the commonest conflict, and CO_MOUNTABLE lists cross-scope pairs only.
	if (a === b) {
		return true
	}

	return CO_MOUNTABLE.some(([first, second]) => (first === a && second === b) || (first === b && second === a))
}

// Every action whose live combo would fire in the same context as `combo`, excluding `excludeId`
// (the action being rebound — re-recording a row with its own current combo is not a conflict).
//
// Matching is per ALTERNATIVE and per KEYSTROKE, not string equality (@filen/shared/keymap's combosOverlap):
// drive.trash's "delete,backspace" fires on either key, "mod+-" and "mod+minus" are one key, and off a Mac
// "mod+ctrl+equal" is the same Ctrl+= as "mod+equal". `mac` picks the platform whose keystrokes are compared.
//
// An empty combo is unbound, not "bound to nothing in particular": it matches no key at all, so it
// never conflicts in either direction.
//
// The rebound action's scope comes from `actions` itself. When `excludeId` names no action in the
// list there is no scope to compare against, so every combo match is reported — a caller that cannot
// say where the binding lives gets the conservative answer, never a false all-clear.
export function conflictingActions<T extends BoundAction>(
	actions: readonly T[],
	combo: string,
	excludeId: string,
	mac: boolean = isMacPlatform()
): readonly T[] {
	if (combo.length === 0) {
		return []
	}

	const subject = actions.find(action => action.id === excludeId)

	return actions.filter(
		action =>
			action.id !== excludeId &&
			action.combo.length > 0 &&
			(subject === undefined || scopesCanCollide(subject.scope, action.scope)) &&
			combosOverlap(action.combo, combo, mac)
	)
}

function isResolvedPair(a: BoundAction, b: BoundAction): boolean {
	return (
		a.overridden !== true &&
		b.overridden !== true &&
		RESOLVED_COLLISIONS.some(([first, second]) => (first === a.id && second === b.id) || (first === b.id && second === a.id))
	)
}

// Every action that shares a keystroke with another one that can be mounted with it, and those others, for the list's
// conflict marker and filter. A shipped pair whose runtime guard keeps them apart (RESOLVED_COLLISIONS) counts only
// once the user has rebound either side. Indexed by keystroke, so it is linear in the bindings, not quadratic.
export function conflictsByAction<T extends BoundAction>(actions: readonly T[], mac: boolean): ReadonlyMap<string, readonly T[]> {
	const byKeystroke = new Map<string, T[]>()

	for (const action of actions) {
		for (const identity of new Set(parseCombo(action.combo).map(chord => chordIdentity(chord, mac)))) {
			const holders = byKeystroke.get(identity)

			if (holders === undefined) {
				byKeystroke.set(identity, [action])
			} else {
				holders.push(action)
			}
		}
	}

	const conflicts = new Map<string, T[]>()

	for (const holders of byKeystroke.values()) {
		if (holders.length < 2) {
			continue
		}

		for (const action of holders) {
			for (const other of holders) {
				if (other === action || !scopesCanCollide(action.scope, other.scope) || isResolvedPair(action, other)) {
					continue
				}

				const list = conflicts.get(action.id)

				if (list === undefined) {
					conflicts.set(action.id, [other])
				} else if (!list.includes(other)) {
					list.push(other)
				}
			}
		}
	}

	return conflicts
}

// A combo without its chords that share a keystroke with `chord`; unbound when nothing is left.
export function comboWithout(combo: string, chord: string, mac: boolean): string {
	const kept = parseCombo(combo).filter(own => !combosOverlap(formatChord(own), chord, mac))

	return kept.length === 0 ? UNBOUND_COMBO : kept.map(formatChord).join(",")
}

// "Reassign": `id` takes `combo`, and every action that conflicts with its new chord gives that chord up.
export function reassignChanges(
	actions: readonly BoundAction[],
	id: string,
	combo: string,
	chord: string,
	mac: boolean
): Record<string, string> {
	const changes: Record<string, string> = { [id]: combo }

	for (const other of conflictingActions(actions, chord, id, mac)) {
		changes[other.id] = comboWithout(other.combo, chord, mac)
	}

	return changes
}

// "Swap": `id` takes `combo`, and the one conflicting action takes the chord `id` gave up in place of the shared one.
export function swapChanges(
	actions: readonly BoundAction[],
	id: string,
	combo: string,
	chord: string,
	replaced: string,
	otherId: string,
	mac: boolean
): Record<string, string> {
	const other = actions.find(action => action.id === otherId)

	if (other === undefined) {
		return { [id]: combo }
	}

	const chords = parseCombo(other.combo).map(own => (combosOverlap(formatChord(own), chord, mac) ? replaced : formatChord(own)))

	return { [id]: combo, [otherId]: [...new Set(chords)].join(",") }
}
