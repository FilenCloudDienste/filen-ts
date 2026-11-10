import { DOCX_KEYS, docxKeyDefault, type DocxKey, type DocxKeyBindings } from "@filen/office/core/docx/keys"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { CURRENT_PLATFORM, defaultComboOn, useBindings, type ActionDef, type KeymapPlatform } from "@/lib/keymap/registry"

// The Word document editor's keys (and the viewer's zoom and Go To), under Editor → Word. The editor's own keys are
// the office package's table (DOCX_KEYS: Word's keys, Word for Mac's, a browser's in place of those it keeps), so the
// defaults here are read from it rather than copied; the editor matches the combos in effect, handed to it as
// bindings (docxKeyBindings below). Bold, italic, link and find are the document editors' shared actions (editor.*),
// so one binding serves every editor. Find and Replace is Word's Ctrl+H here, not editor.replace's Mod+Alt+F, which
// is Word's Insert Footnote. The keys only the host runs (zoom, Word Count, the panes, PDF) go through useAction in
// the editor's layer.
type WordActionDef = ActionDef & { readonly section: "word" }

const PLATFORMS: readonly KeymapPlatform[] = [
	{ mac: true, desktop: false },
	{ mac: false, desktop: true },
	{ mac: true, desktop: true }
]

const KEYS: ReadonlyMap<string, DocxKey> = new Map(DOCX_KEYS.map(key => [key.id, key]))

// An action on one of the editor's keys: Word's default on a Windows or Linux browser, the other platforms' where
// they differ.
function wordKey(id: string, key: string, descriptionKey: ActionDef["descriptionKey"]): WordActionDef {
	const entry = KEYS.get(key)

	if (entry === undefined) {
		throw new Error(`docx keymap: no key "${key}"`)
	}

	const defaultCombo = docxKeyDefault(entry, false, false)
	const platformDefaults = PLATFORMS.flatMap(on => {
		const combo = docxKeyDefault(entry, on.mac, on.desktop)

		return combo === defaultCombo ? [] : [{ on, combo }]
	})

	return {
		id,
		defaultCombo,
		...(platformDefaults.length === 0 ? {} : { platformDefaults }),
		scope: "editor",
		section: "word",
		descriptionKey
	}
}

function hostKey(id: string, defaultCombo: string, descriptionKey: ActionDef["descriptionKey"]): WordActionDef {
	return { id, defaultCombo, scope: "editor", section: "word", descriptionKey }
}

// Each editor key's action, in the order Settings → Keyboard lists them: editing, formatting, paragraphs, insert,
// fields, review, view.
const KEY_ACTIONS: readonly (readonly [action: string, key: string, descriptionKey: ActionDef["descriptionKey"]])[] = [
	["docx.undo", "history.undo", "preview:previewDocxUndo"],
	["docx.redo", "history.redo", "preview:previewDocxRedo"],
	["docx.repeat", "repeat", "preview:previewDocxKeyRepeat"],
	["docx.replace", "replace", "preview:previewDocxFindReplaceAction"],
	["docx.goTo", "goTo", "preview:previewDocxKeyGoTo"],
	["docx.underline", "format.underline", "preview:previewDocxUnderline"],
	["docx.doubleUnderline", "format.doubleUnderline", "preview:previewDocxDoubleUnderline"],
	["docx.strikethrough", "format.strike", "preview:previewDocxStrikethrough"],
	["docx.superscript", "format.superscript", "preview:previewDocxSuperscript"],
	["docx.subscript", "format.subscript", "preview:previewDocxSubscript"],
	["docx.smallCaps", "format.smallCaps", "preview:previewDocxSmallCaps"],
	["docx.allCaps", "format.allCaps", "preview:previewDocxAllCaps"],
	["docx.changeCase", "format.changeCase", "preview:previewDocxChangeCase"],
	["docx.clearFormatting", "format.clear", "preview:previewDocxClearFormatting"],
	["docx.growFont", "font.grow", "preview:previewDocxFontGrow"],
	["docx.shrinkFont", "font.shrink", "preview:previewDocxFontShrink"],
	["docx.growFontPoint", "font.growPoint", "preview:previewDocxFontGrowPoint"],
	["docx.shrinkFontPoint", "font.shrinkPoint", "preview:previewDocxFontShrinkPoint"],
	["docx.copyFormatting", "format.copy", "preview:previewDocxKeyCopyFormatting"],
	["docx.pasteFormatting", "format.paste", "preview:previewDocxPasteFormatting"],
	["docx.styleNormal", "style.normal", "preview:previewDocxKeyStyleNormal"],
	["docx.headingOne", "style.heading1", "preview:previewDocxKeyHeading1"],
	["docx.headingTwo", "style.heading2", "preview:previewDocxKeyHeading2"],
	["docx.headingThree", "style.heading3", "preview:previewDocxKeyHeading3"],
	["docx.alignLeft", "align.start", "preview:previewDocxAlignStart"],
	["docx.alignCenter", "align.center", "preview:previewDocxAlignCenter"],
	["docx.alignRight", "align.end", "preview:previewDocxAlignEnd"],
	["docx.justify", "align.justify", "preview:previewDocxAlignJustify"],
	["docx.bulletList", "list.bullet", "preview:previewDocxBulletList"],
	["docx.numberedList", "list.numbered", "preview:previewDocxNumberedList"],
	["docx.indent", "list.indent", "preview:previewDocxIndent"],
	["docx.outdent", "list.outdent", "preview:previewDocxOutdent"],
	["docx.hangingIndent", "paragraph.hangingIndent", "preview:previewDocxHangingIndent"],
	["docx.unhang", "paragraph.unhang", "preview:previewDocxKeyUnhang"],
	["docx.lineSpacingSingle", "paragraph.lineSpacing1", "preview:previewDocxKeyLineSpacing1"],
	["docx.lineSpacingOneAndHalf", "paragraph.lineSpacing15", "preview:previewDocxKeyLineSpacing15"],
	["docx.lineSpacingDouble", "paragraph.lineSpacing2", "preview:previewDocxKeyLineSpacing2"],
	["docx.insertPageBreak", "insert.pageBreak", "preview:previewDocxKeyPageBreak"],
	["docx.insertSectionBreak", "insert.sectionBreak", "preview:previewDocxKeySectionBreak"],
	["docx.insertTable", "table.insert", "preview:previewDocxKeyTable"],
	["docx.insertSymbol", "insert.symbol", "preview:previewDocxKeySymbol"],
	["docx.insertEquation", "equation.insert", "preview:previewDocxEquationInsert"],
	["docx.insertFootnote", "note.insertFootnote", "preview:previewDocxKeyFootnote"],
	["docx.insertEndnote", "note.insertEndnote", "preview:previewDocxKeyEndnote"],
	["docx.insertPageNumber", "insert.pageNumber", "preview:previewDocxKeyPageNumber"],
	["docx.insertDate", "insert.dateField", "preview:previewDocxKeyDateField"],
	["docx.insertTime", "insert.timeField", "preview:previewDocxKeyTimeField"],
	["docx.updateField", "field.update", "preview:previewDocxUpdateField"],
	["docx.updateAllFields", "field.updateAll", "preview:previewDocxUpdateAllFields"],
	["docx.updateToc", "toc.update", "preview:previewDocxKeyUpdateToc"],
	["docx.unlinkFields", "field.unlink", "preview:previewDocxUnlinkFields"],
	["docx.fieldCodes", "view.fieldCodes", "preview:previewDocxShowFieldCodes"],
	["docx.toggleFieldCode", "view.fieldCode", "preview:previewDocxToggleFieldCode"],
	["docx.trackChanges", "review.track", "preview:previewDocxTrackChanges"],
	["docx.newComment", "comment.add", "preview:previewDocxNewComment"],
	["docx.nextComment", "comment.next", "preview:previewDocxNextComment"],
	["docx.previousComment", "comment.prev", "preview:previewDocxPreviousComment"],
	["docx.nextChange", "review.next", "preview:previewDocxNextChange"],
	["docx.previousChange", "review.prev", "preview:previewDocxPreviousChange"],
	["docx.acceptChange", "review.accept", "preview:previewDocxAcceptChange"],
	["docx.rejectChange", "review.reject", "preview:previewDocxRejectChange"],
	["docx.acceptAll", "review.acceptAll", "preview:previewDocxAcceptAll"],
	["docx.rejectAll", "review.rejectAll", "preview:previewDocxRejectAll"],
	["docx.pageSetup", "page.setup", "preview:previewDocxPageSetup"],
	["docx.formattingMarks", "view.formattingMarks", "preview:previewDocxShowFormattingMarks"]
]

// The editor's keys that are the document editors' shared actions.
const SHARED_KEYS: readonly (readonly [action: string, key: string])[] = [
	["editor.find", "find"],
	["editor.bold", "format.bold"],
	["editor.italic", "format.italic"],
	["editor.link", "link.set"]
]

// Zoom as the PDF viewer's (Mod with "=" or the numpad's +, "-" or the numpad's -, 0), less Mod+Shift+=, Word's
// superscript. Word Count is Google Docs' Mod+Shift+G; Mod+P downloads the PDF, the editor's way to print. The panes
// have no key of Word's.
export const DOCX_HOST_ACTIONS: readonly WordActionDef[] = [
	hostKey("docx.zoomIn", "mod+equal,mod+add", "preview:previewDocxKeyZoomIn"),
	hostKey("docx.zoomOut", "mod+minus,mod+subtract", "preview:previewDocxKeyZoomOut"),
	hostKey("docx.zoomReset", "mod+0", "preview:previewDocxKeyZoomReset"),
	hostKey("docx.wordCount", "mod+shift+g", "preview:previewDocxKeyWordCount"),
	hostKey("docx.navigationPane", "", "preview:previewDocxKeyNavigationPane"),
	hostKey("docx.mobileView", "", "preview:previewDocxKeyMobileView"),
	hostKey("docx.downloadPdf", "mod+p", "preview:previewDocxKeyDownloadPdf")
]

export const DOCX_ACTIONS: readonly WordActionDef[] = [
	...KEY_ACTIONS.map(([action, key, descriptionKey]) => wordKey(action, key, descriptionKey)),
	...DOCX_HOST_ACTIONS
]

// The action each editor key runs.
export const DOCX_KEY_ACTIONS: ReadonlyMap<string, string> = new Map([
	...KEY_ACTIONS.map(([action, key]) => [key, action] as const),
	...SHARED_KEYS.map(([action, key]) => [key, action] as const)
])

const DEFINITIONS: ReadonlyMap<string, ActionDef> = new Map([...DOCX_ACTIONS, ...PREVIEW_ACTIONS].map(def => [def.id, def] as const))

const fromCombos = new WeakMap<Readonly<Record<string, string>>, DocxKeyBindings>()

// The editor's bindings from the combos in effect by action id (useBindings; an action's own default on this platform
// where one is missing). One object per combos object, so the editor parses them once per change of a binding.
export function docxKeyBindings(combos: Readonly<Record<string, string>>): DocxKeyBindings {
	const known = fromCombos.get(combos)

	if (known !== undefined) {
		return known
	}

	const bindings: Record<string, string> = {}

	for (const [key, action] of DOCX_KEY_ACTIONS) {
		const def = DEFINITIONS.get(action)

		bindings[key] = combos[action] ?? (def === undefined ? "" : defaultComboOn(def, CURRENT_PLATFORM))
	}

	fromCombos.set(combos, bindings)

	return bindings
}

// The bindings for the mounted editor, following the user's changes as they make them.
export function useDocxKeyBindings(): DocxKeyBindings {
	return docxKeyBindings(useBindings())
}

// The action whose key runs a line spacing multiple (Word's single, 1.5 and double), for the menu's hints.
const LINE_SPACING_ACTIONS: ReadonlyMap<number, string> = new Map(
	DOCX_KEYS.flatMap(key => {
		const command = key.run.kind === "command" ? key.run.command : undefined
		const action = DOCX_KEY_ACTIONS.get(key.id)

		return command?.type === "paragraph.lineSpacing" && command.rule === "auto" && action !== undefined
			? [[command.value, action] as const]
			: []
	})
)

export function lineSpacingAction(value: number): string | undefined {
	return LINE_SPACING_ACTIONS.get(value)
}
