import type { Node } from "prosemirror-model"
import type { DocxEditContext } from "../../edit/context"
import { decodeUtf8 } from "../../../xml/index"
import { documentNotePosition } from "../../layout/notes"
import { Ns } from "../../model/namespaces"
import { documentProtectionHashAttributes } from "../../protection/hash"
import { partReader, type PartReader } from "../../model/reader"
import { trackingPersisted } from "../../review/track"
import { docSectionChanges, sectionStoryReferenced } from "../../stories/sections"
import { Names, Out, freshContainer, spliceChildren } from "../markup"
import { W_NAMESPACE } from "../source"
import { DocxWriteError } from "../values"
import type { PartContributor, SaveParts, WrittenStories } from "./index"

// settings.xml: the track switch (w:trackRevisions) where the editor turned it from what the file has, the
// even/odd headers switch (w:evenAndOddHeaders), mirror margins (w:mirrorMargins) and where notes go (w:pos of w:footnotePr / w:endnotePr) as the
// body's section edits set them, and w:documentProtection as the user started it, or switched off once they stopped it; nothing else of the part changes. A package without settings gets a part holding only those. A notes part the save makes gets no
// separator list here: its separator notes carry w:type, and layout reads the list as the source has it. The
// contributor also claims the body's section edits (written with the stories, see write/sections.ts) and the
// header and footer stories sections refer to.

const SETTINGS_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings"
const SETTINGS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"

// CT_Settings (wml.xsd), in schema order.
const SETTINGS: readonly string[] = [
	"writeProtection",
	"view",
	"zoom",
	"removePersonalInformation",
	"removeDateAndTime",
	"doNotDisplayPageBoundaries",
	"displayBackgroundShape",
	"printPostScriptOverText",
	"printFractionalCharacterWidth",
	"printFormsData",
	"embedTrueTypeFonts",
	"embedSystemFonts",
	"saveSubsetFonts",
	"saveFormsData",
	"mirrorMargins",
	"alignBordersAndEdges",
	"bordersDoNotSurroundHeader",
	"bordersDoNotSurroundFooter",
	"gutterAtTop",
	"hideSpellingErrors",
	"hideGrammaticalErrors",
	"activeWritingStyle",
	"proofState",
	"formsDesign",
	"attachedTemplate",
	"linkStyles",
	"stylePaneFormatFilter",
	"stylePaneSortMethod",
	"documentType",
	"mailMerge",
	"revisionView",
	"trackRevisions",
	"doNotTrackMoves",
	"doNotTrackFormatting",
	"documentProtection",
	"autoFormatOverride",
	"styleLockTheme",
	"styleLockQFSet",
	"defaultTabStop",
	"autoHyphenation",
	"consecutiveHyphenLimit",
	"hyphenationZone",
	"doNotHyphenateCaps",
	"showEnvelope",
	"summaryLength",
	"clickAndTypeStyle",
	"defaultTableStyle",
	"evenAndOddHeaders",
	"bookFoldRevPrinting",
	"bookFoldPrinting",
	"bookFoldPrintingSheets",
	"drawingGridHorizontalSpacing",
	"drawingGridVerticalSpacing",
	"displayHorizontalDrawingGridEvery",
	"displayVerticalDrawingGridEvery",
	"doNotUseMarginsForDrawingGridOrigin",
	"drawingGridHorizontalOrigin",
	"drawingGridVerticalOrigin",
	"doNotShadeFormData",
	"noPunctuationKerning",
	"characterSpacingControl",
	"printTwoOnOne",
	"strictFirstAndLastChars",
	"noLineBreaksAfter",
	"noLineBreaksBefore",
	"savePreviewPicture",
	"doNotValidateAgainstSchema",
	"saveInvalidXml",
	"ignoreMixedContent",
	"alwaysShowPlaceholderText",
	"doNotDemarcateInvalidXml",
	"saveXmlDataOnly",
	"useXSLTWhenSaving",
	"saveThroughXslt",
	"showXMLTags",
	"alwaysMergeEmptyNamespace",
	"updateFields",
	"hdrShapeDefaults",
	"footnotePr",
	"endnotePr",
	"compat",
	"docVars",
	"rsids",
	"attachedSchema",
	"themeFontLang",
	"clrSchemeMapping",
	"doNotIncludeSubdocsInStats",
	"doNotAutoCompressPictures",
	"forceUpgrade",
	"captions",
	"readModeInkLockDown",
	"smartTagType",
	"shapeDefaults",
	"doNotEmbedSmartTags",
	"decimalSymbol",
	"listSeparator"
]

// CT_FtnDocProps / CT_EdnDocProps: CT_FtnProps / CT_EdnProps, then the separator note ids.
const NOTE_PROPERTIES: readonly string[] = ["pos", "numFmt", "numStart", "numRestart", "footnote", "endnote"]

// A child of settings as it is (its reader and node), or undefined where the part has none.
type Existing = { readonly reader: PartReader; readonly node: number } | undefined

type SettingsChange = (names: Names, existing: Existing) => string

// settings.xml with `changes` spliced in (a package without settings gets a part holding only them).
async function writeSettings(parts: SaveParts, changes: ReadonlyMap<string, SettingsChange>): Promise<void> {
	const pkg = parts.pkg
	const name = pkg.part("settings")
	const xml = name === undefined ? undefined : await parts.xml(name)

	if (name === undefined || xml === undefined) {
		const names = new Names("w", "")
		const children = [...changes]
			.map(([local, make]): [string, string] => [local, make(names, undefined)])
			.filter(([, markup]) => markup !== "")

		// Nothing to switch off in a package without settings.
		if (children.length === 0) return
		if (parts.context.model.strict) throw new DocxWriteError("unsupported", "New settings in a Strict document")

		const main = pkg.mainPart
		const target = parts.freeName(main.replace(/[^/]*$/, "settings.xml"))
		const body = children
			.sort(([a], [b]) => SETTINGS.indexOf(a) - SETTINGS.indexOf(b))
			.map(([, markup]) => markup)
			.join("")

		parts.add(
			target,
			new TextEncoder().encode(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:settings xmlns:w="${W_NAMESPACE}">${body}</w:settings>`
			),
			SETTINGS_CONTENT_TYPE
		)
		parts.relationship(main, { type: SETTINGS_TYPE, target: target.slice(target.lastIndexOf("/") + 1) })

		return
	}

	const reader = partReader(xml)
	const root = xml.documentElement()
	const names = new Names(reader.namespaces.prefixFor(root, W_NAMESPACE) ?? "w", "")
	const out = new Out()

	out.bytes(xml.bytes, 0, xml.start(root))
	const existing = (local: string): Existing => {
		for (let child = xml.firstChildElement(root); child >= 0; child = xml.nextSiblingElement(child))
			if (reader.is(child, Ns.W, local)) return { reader, node: child }

		return undefined
	}

	spliceChildren(out, reader, root, new Map([...changes].map(([local, make]) => [local, make(names, existing(local))])), SETTINGS)
	out.bytes(xml.bytes, xml.end(root), xml.bytes.length)
	parts.replace(name, out.finish())
}

// The body's document among those written.
function bodyDoc(context: DocxEditContext, written: WrittenStories): Node | undefined {
	const index = written.sessions.findIndex(session => session.story.story === context.model.body)

	return index < 0 ? undefined : (written.docs[index] ?? written.sessions[index]?.state.doc)
}

export const settingsParts: PartContributor = {
	// Section edits (sections.ts writes them) and the document-wide even/odd switch.
	attributes: ["sectionChanges"],
	references: (story, docs) => (story.kind === "header" || story.kind === "footer") && sectionStoryReferenced(story, docs),
	async contribute(parts, written) {
		const context = parts.context
		const model = context.model
		const changes = new Map<string, SettingsChange>()
		const on = context.review.tracking

		if (on !== model.settings.trackRevisions && trackingPersisted(context))
			changes.set("trackRevisions", names => (on ? names.empty("trackRevisions") : ""))

		const doc = bodyDoc(context, written)
		const edits = doc === undefined ? undefined : docSectionChanges(doc)
		const evenAndOdd = edits?.evenAndOddHeaders

		if (evenAndOdd !== undefined && evenAndOdd !== model.settings.evenAndOddHeaders)
			changes.set("evenAndOddHeaders", names => (evenAndOdd ? names.empty("evenAndOddHeaders") : ""))

		const mirror = edits?.mirrorMargins

		if (mirror !== undefined && mirror !== model.settings.mirrorMargins)
			changes.set("mirrorMargins", names => (mirror ? names.empty("mirrorMargins") : ""))

		for (const [local, position, endnote] of [
			["footnotePr", edits?.footnotePosition, false],
			["endnotePr", edits?.endnotePosition, true]
		] as const) {
			if (position === undefined || position === documentNotePosition(model, endnote)) continue

			changes.set(local, (names, existing) => {
				const pos = new Map([["pos", names.val("pos", position)]])

				if (existing === undefined) return freshContainer(names, local, pos, NOTE_PROPERTIES)

				const out = new Out()

				spliceChildren(out, existing.reader, existing.node, pos, NOTE_PROPERTIES)

				return decodeUtf8(out.finish())
			})
		}

		const change = context.protectionChange

		// Protection started in the session: the element as Word writes it, replacing what the file had.
		if (change !== undefined && change !== "stopped")
			changes.set("documentProtection", names =>
				names.empty("documentProtection", [
					["edit", change.edit],
					["formatting", change.formatting ? "1" : undefined],
					["enforcement", "1"],
					...(change.password === undefined ? [] : documentProtectionHashAttributes(change.password))
				])
			)
		// Stop Protection: the element stays with its restriction choices, enforcement off and the hash dropped
		// (the password went with the protection).
		else if ((change === "stopped" || context.protectionUnlocked === true) && model.settings.documentProtection?.enforced === true)
			changes.set("documentProtection", (names, existing) => {
				const attr = (local: string): string | undefined => existing?.reader.attr(existing.node, Ns.W, local)

				return names.empty("documentProtection", [
					["edit", attr("edit")],
					["formatting", attr("formatting")],
					["enforcement", "0"]
				])
			})

		if (changes.size === 0) return

		await writeSettings(parts, changes)
	}
}
