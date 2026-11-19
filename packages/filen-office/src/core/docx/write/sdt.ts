import type { Mark, Node } from "prosemirror-model"
import { NodeKind, decodeUtf8, escapeAttribute } from "../../xml/index"
import {
	CHECKED_GLYPH,
	GLYPH_FONT,
	UNCHECKED_GLYPH,
	controlState,
	formFieldData,
	type ControlListItem,
	type ControlState,
	type FormFieldData,
	type LegacyFieldState,
	type MadeControl
} from "../forms/controls"
import { NO_SOURCE, docxSchema } from "../edit/schema"
import { Item, type StoryPart } from "../model/index"
import { Ns } from "../model/namespaces"
import { MAIN, dataMarkup as elementMarkup, type ElementData } from "../edit/copies"
import { copyNode, openTag, spliceChildren, textElement, type Names, type Out } from "./markup"
import { src } from "./source"
import type { StoryWriting } from "./story"
import { DocxWriteError } from "./values"
import type { WrapperWriter } from "./wrappers"

// Content controls (ECMA-376 Part 1 §17.5.2 w:sdt) and legacy form fields (§17.16.17 w:ffData). A control as
// the source has it is written as its bytes; one a form command changed gets its w:sdtPr spliced (the checkbox
// state, the chosen list value, the date, the placeholder flag) with everything else kept; one the editor made
// is written new.

const W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
const W15 = "http://schemas.microsoft.com/office/word/2012/wordml"
// CT_SdtPr's sequence (§17.5.2.38): w:showingPlcHdr comes after these; a type element or an extension after it.
const BEFORE_PLACEHOLDER_FLAG = new Set(["rPr", "alias", "tag", "id", "lock", "placeholder", "temporary"])
const LEGACY_FIELD_TYPES = new Set(["FORMTEXT", "FORMCHECKBOX", "FORMDROPDOWN"])

// A block-level content control: its w:sdtPr and w:sdtEndPr as they were (spliced for a state a form command
// set), its content written as blocks.
export function* writeSdt(w: StoryWriting, out: Out, node: Node): Generator<void, void> {
	const part = w.part
	const document = part.document
	const names = w.names
	const state = controlState(node)
	const own = src(node)

	if (!w.owns(node) && own !== NO_SOURCE && part.kinds[own] === Item.Sdt) {
		const row = part.aux[own] ?? -1

		out.text(`<${names.el("sdt")}>`)

		if (state === null) w.copyProperties(out, [part.sdts.sdtPr[row] ?? -1, part.sdts.sdtEndPr[row] ?? -1], ["id"])
		else {
			writeSdtPr(w, out, part.sdts.sdtPr[row] ?? -1, state, true)
			w.copyProperties(out, [part.sdts.sdtEndPr[row] ?? -1], [])
		}

		out.text(`<${names.el("sdtContent")}>`)
		yield* w.writeChildren(out, node, NO_SOURCE, (child, blockOut) => w.writeBlock(blockOut, child))
		out.text(`</${names.el("sdtContent")}></${names.el("sdt")}>`)

		return
	}

	if (!w.owns(node)) {
		if (state !== null && state.made === undefined && state.copy === undefined && state.properties === undefined)
			throw new DocxWriteError("missingSource", "A changed content control without its source")

		out.text(`<${names.el("sdt")}>`)

		if (state?.made !== undefined) writeNewSdtPr(w, out, state.made, state)
		else if (state?.copy !== undefined) writeCopiedSdtPr(w, out, state.copy, state)
		else if (state?.properties !== undefined) out.text(dataSdtPr(w, state.properties, state))
		else out.text(`<${names.el("sdtPr")}/>`)

		out.text(`<${names.el("sdtContent")}>`)
		yield* w.writeChildren(out, node, NO_SOURCE, (child, blockOut) => w.writeBlock(blockOut, child))
		out.text(`</${names.el("sdtContent")}></${names.el("sdt")}>`)

		return
	}

	const item = src(node)
	const row = part.aux[item] ?? -1
	const content = part.sdts.content[row] ?? -1

	if (content < 0) throw new DocxWriteError("missingSource", "A content control without content")

	const element = part.node(item)

	if (state === null) out.bytes(w.bytes, document.start(element), document.openEnd(content))
	else spliceSdtStart(w, out, element, part.sdts.sdtPr[row] ?? -1, content, state, false)

	yield* w.writeChildren(out, node, item, (child, blockOut) => w.writeBlock(blockOut, child), {
		from: document.openEnd(content),
		to: document.contentEnd(content),
		tail: []
	})
	out.bytes(w.bytes, document.contentEnd(content), document.end(element))
}

// Whether a form command set a control's state (checked, chosen, dated, placeholder): its runs are written
// through the edit path.
export function changedControl(holder: Node | Mark): boolean {
	return (holder.attrs["state"] ?? null) !== null
}

// The source element's bytes up to its w:sdtContent start tag with w:sdtPr spliced for `state` (a w:sdtPr the
// source lacks is added first).
function spliceSdtStart(
	w: StoryWriting,
	out: Out,
	element: number,
	sdtPr: number,
	content: number,
	state: ControlState,
	dropId: boolean
): void {
	const document = w.part.document

	if (sdtPr < 0) {
		out.bytes(w.bytes, document.start(element), document.openEnd(element))
		writeSdtPr(w, out, -1, state, dropId)
		out.bytes(w.bytes, document.openEnd(element), document.openEnd(content))

		return
	}

	out.bytes(w.bytes, document.start(element), document.start(sdtPr))
	writeSdtPr(w, out, sdtPr, state, dropId)
	out.bytes(w.bytes, document.end(sdtPr), document.openEnd(content))
}

// A source w:sdtPr with `state` applied: w14:checked, w:lastValue, w:fullDate and w:showingPlcHdr set, w:id
// left out (`dropId`: a second part of a split control, or a copy).
function writeSdtPr(w: StoryWriting, out: Out, sdtPr: number, state: ControlState, dropId: boolean): void {
	const names = w.names

	if (sdtPr < 0) {
		out.text(
			state.placeholder === true
				? `<${names.el("sdtPr")}>${names.empty("showingPlcHdr")}</${names.el("sdtPr")}>`
				: `<${names.el("sdtPr")}/>`
		)

		return
	}

	const part = w.part
	const document = part.document
	const reader = part.reader
	let flagDone = state.placeholder !== true
	const flag = (): void => {
		if (!flagDone) out.text(names.empty("showingPlcHdr"))

		flagDone = true
	}

	openTag(out, document, sdtPr)

	for (let child = document.firstChild(sdtPr); child >= 0; child = document.nextSibling(child)) {
		if (document.kinds[child] !== NodeKind.Element) {
			copyNode(out, document, child)

			continue
		}

		const group = reader.group(child)
		const local = document.localName(child)
		const ordered = group === Ns.W && BEFORE_PLACEHOLDER_FLAG.has(local)

		if (!ordered && !(group === Ns.W && local === "showingPlcHdr")) flag()

		if (group === Ns.W) {
			switch (local) {
				case "id":
					if (!dropId) copyNode(out, document, child)

					continue
				case "showingPlcHdr":
					if (state.placeholder === undefined) copyNode(out, document, child)
					else flag()

					flagDone = true

					continue
				case "dropDownList":
				case "comboBox":
					if (state.items !== undefined) listWith(out, part, child, names, state)
					else if (state.value === undefined) copyNode(out, document, child)
					else withAttribute(out, part, child, names.attr("lastValue"), state.value)

					continue
				case "date":
					if (state.date === undefined) copyNode(out, document, child)
					else withAttribute(out, part, child, names.attr("fullDate"), state.date === null ? null : `${state.date}T00:00:00Z`)

					continue
			}
		} else if (group === Ns.W14 && local === "checkbox" && state.checked !== undefined) {
			checkboxWith(out, part, child, state.checked)

			continue
		}

		copyNode(out, document, child)
	}

	flag()
	closeElement(out, part, sdtPr)
}

function closeElement(out: Out, part: StoryPart, node: number): void {
	const document = part.document

	if (document.isSelfClosing(node)) out.text(`</${document.name(node)}>`)
	else out.bytes(document.bytes, document.contentEnd(node), document.end(node))
}

// An element with one attribute set (null: removed), its content as it was.
function withAttribute(out: Out, part: StoryPart, node: number, qualifiedName: string, value: string | null): void {
	const document = part.document
	const bytes = document.bytes
	const self = document.isSelfClosing(node)
	let tag = `<${document.name(node)}`

	for (const attribute of document.attributes(node)) {
		if (attribute.name !== qualifiedName) tag += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
	}

	if (value !== null) tag += ` ${qualifiedName}="${escapeAttribute(value)}"`

	out.text(self ? `${tag}/>` : `${tag}>`)

	if (!self) out.bytes(bytes, document.openEnd(node), document.end(node))
}

// A w:listItem's attributes: w:displayText left out of a value-only entry (Word's "Choose an item.").
function listItemAttributes(item: ControlListItem): [string, string][] {
	return item.valueOnly === true
		? [["value", item.value]]
		: [
				["displayText", item.text],
				["value", item.value]
			]
}

// A w:dropDownList or w:comboBox with the entries control.items gave (w:listItem, ECMA-376 Part 1 §17.5.2.21),
// its own attributes kept but w:lastValue, which `state` sets (or the source's, when it is one of them).
function listWith(out: Out, part: StoryPart, node: number, names: Names, state: ControlState): void {
	const document = part.document
	const lastName = names.attr("lastValue")
	const sourceLast = document.attributes(node).find(attribute => attribute.name === lastName)?.value
	const items = state.items ?? []
	const last = state.value !== undefined ? state.value : items.some(item => item.value === sourceLast) ? (sourceLast ?? null) : null
	let tag = `<${document.name(node)}`

	for (const attribute of document.attributes(node)) {
		if (attribute.name !== lastName) tag += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`
	}

	if (last !== null) tag += attr(lastName, last)

	out.text(`${tag}>`)

	for (const item of items) out.text(names.empty("listItem", listItemAttributes(item)))

	out.text(`</${document.name(node)}>`)
}

// w14:checkbox with w14:checked set (MS-DOCX §2.6.1.2), in the element's own prefix.
function checkboxWith(out: Out, part: StoryPart, node: number, checked: boolean): void {
	const document = part.document
	const reader = part.reader
	const name = document.name(node)
	const prefix = name.includes(":") ? `${name.slice(0, name.indexOf(":"))}:` : ""
	const value = `<${prefix}checked ${prefix}val="${checked ? "1" : "0"}"/>`
	let written = false

	openTag(out, document, node)

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		if (document.kinds[child] === NodeKind.Element && reader.is(child, Ns.W14, "checked")) {
			if (!written) out.text(value)

			written = true

			continue
		}

		if (!written && document.kinds[child] === NodeKind.Element) {
			out.text(value)
			written = true
		}

		copyNode(out, document, child)
	}

	if (!written) out.text(value)

	closeElement(out, part, node)
}

// The prefix the part's root binds `uri` to, with a declaration for an element when it binds none.
function prefixFor(part: StoryPart, uri: string, fallback: string): { prefix: string; declare: string } {
	const root = part.document.documentElement()
	const bound = root < 0 ? undefined : part.reader.namespaces.prefixFor(root, uri)

	return bound === undefined || bound === ""
		? { prefix: fallback, declare: ` xmlns:${fallback}="${uri}"` }
		: { prefix: bound, declare: "" }
}

// A w14:checkedState / uncheckedState w14:val: the code point as four or more upper-case hex digits.
function glyphHex(codePoint: number): string {
	return codePoint.toString(16).toUpperCase().padStart(4, "0")
}

function attr(name: string, value: string): string {
	return ` ${name}="${escapeAttribute(value)}"`
}

// The w:sdtPr of a control the editor made.
export function newSdtPr(names: Names, part: StoryPart, made: MadeControl, state: ControlState, again = false): string {
	let out = `<${names.el("sdtPr")}>${again ? "" : names.val("id", made.id)}`

	if (state.placeholder === true) out += names.empty("showingPlcHdr")

	switch (made.type) {
		case "plainText":
			out += names.empty("text")
			break
		case "picture":
			out += names.empty("picture")
			break
		case "checkbox": {
			const { prefix, declare } = prefixFor(part, W14, "w14")
			const el = (local: string): string => `${prefix}:${local}`

			out +=
				`<${el("checkbox")}${declare}><${el("checked")}${attr(el("val"), state.checked === true ? "1" : "0")}/>` +
				`<${el("checkedState")}${attr(el("val"), glyphHex(CHECKED_GLYPH))}${attr(el("font"), GLYPH_FONT)}/>` +
				`<${el("uncheckedState")}${attr(el("val"), glyphHex(UNCHECKED_GLYPH))}${attr(el("font"), GLYPH_FONT)}/></${el("checkbox")}>`
			break
		}
		case "dropDownList":
		case "comboBox": {
			const value = state.value ?? null

			out += `<${names.el(made.type)}${value === null ? "" : attr(names.attr("lastValue"), value)}>`

			for (const item of made.items ?? []) out += names.empty("listItem", listItemAttributes(item))

			out += `</${names.el(made.type)}>`
			break
		}
		case "date": {
			const iso = state.date ?? null

			out +=
				`<${names.el("date")}${iso === null ? "" : attr(names.attr("fullDate"), `${iso}T00:00:00Z`)}>` +
				`${names.val("dateFormat", made.dateFormat ?? "M/d/yyyy")}${names.val("lid", made.lid ?? "en-US")}` +
				`${names.val("storeMappedDataAs", "dateTime")}${names.val("calendar", "gregorian")}</${names.el("date")}>`
			break
		}
		case "repeatingSection":
		case "repeatingSectionItem": {
			const { prefix, declare } = prefixFor(part, W15, "w15")

			out += `<${prefix}:${made.type}${declare}/>`
			break
		}
		case "richText":
			break
	}

	return `${out}</${names.el("sdtPr")}>`
}

// Made controls of a story writing already written: a piece after the first (content an edit split, around a
// tracked change in it) has no w:id of its own, as a split source control's (w:id is unique in a part).
const madeWritten = new WeakMap<StoryWriting, Set<string>>()

function writeNewSdtPr(w: StoryWriting, out: Out, made: MadeControl, state: ControlState): void {
	let written = madeWritten.get(w)

	if (written === undefined) {
		written = new Set()
		madeWritten.set(w, written)
	}

	out.text(newSdtPr(w.names, w.part, made, state, written.has(made.id)))
	written.add(made.id)
}

// The w:sdtPr of a copy of source control `copy`: the source's without its w:id, with `state` applied.
function writeCopiedSdtPr(w: StoryWriting, out: Out, copy: number, state: ControlState): void {
	const part = w.part

	if (copy < 0 || copy >= part.count || part.kinds[copy] !== Item.Sdt)
		throw new DocxWriteError("missingSource", "A copied content control without its source")

	writeSdtPr(w, out, part.sdts.sdtPr[part.aux[copy] ?? -1] ?? -1, state, true)
}

// The w:sdtPr of a copy of another part's control (`data`: its w:sdtPr without w:id) with `state` applied.
function dataSdtPr(w: StoryWriting, data: ElementData, state: ControlState): string {
	const attr = (element: ElementData, name: string, value: string | null): ElementData => ({
		...element,
		attrs: [
			...element.attrs.filter(([uri, local]) => !(uri === MAIN && local === name)),
			...(value === null ? [] : [[MAIN, name, value] as const])
		]
	})
	let children = data.children.flatMap((child): ElementData[] => {
		if (child.uri === MAIN && child.name === "showingPlcHdr" && state.placeholder !== undefined) return []
		if (child.uri === MAIN && (child.name === "dropDownList" || child.name === "comboBox") && state.items !== undefined) {
			const sourceLast = child.attrs.find(([uri, local]) => uri === MAIN && local === "lastValue")?.[2]
			const last =
				state.value !== undefined ? state.value : state.items.some(item => item.value === sourceLast) ? (sourceLast ?? null) : null
			const entries: ElementData[] = state.items.map(item => ({
				uri: MAIN,
				name: "listItem",
				attrs: listItemAttributes(item).map(([name, value]) => [MAIN, name, value] as const),
				children: []
			}))

			return [{ ...attr(child, "lastValue", last), children: entries }]
		}
		if (child.uri === MAIN && (child.name === "dropDownList" || child.name === "comboBox") && state.value !== undefined)
			return [attr(child, "lastValue", state.value)]
		if (child.uri === MAIN && child.name === "date" && state.date !== undefined)
			return [attr(child, "fullDate", state.date === null ? null : `${state.date}T00:00:00Z`)]
		if (child.uri === W14 && child.name === "checkbox" && state.checked !== undefined) {
			const checked: ElementData = { uri: W14, name: "checked", attrs: [[W14, "val", state.checked ? "1" : "0"]], children: [] }

			return [{ ...child, children: [checked, ...child.children.filter(inner => !(inner.uri === W14 && inner.name === "checked"))] }]
		}

		return [child]
	})

	if (state.placeholder === true) {
		const at = children.findIndex(child => !(child.uri === MAIN && BEFORE_PLACEHOLDER_FLAG.has(child.name)))
		const flag: ElementData = { uri: MAIN, name: "showingPlcHdr", attrs: [], children: [] }

		children = at < 0 ? [...children, flag] : [...children.slice(0, at), flag, ...children.slice(at)]
	}

	return elementMarkup(w.part, w.names.w, { ...data, children })
}

// The start of source content control `own` (`mark`) around inline content, up to its w:sdtContent start
// tag. `again`: a content control split in two, whose second part has no w:id of its own.
export function openSdtWrapper(w: StoryWriting, out: Out, mark: Mark, own: number, again: boolean): void {
	const part = w.part
	const document = part.document
	const element = part.node(own)
	const row = part.aux[own] ?? -1
	const content = part.sdts.content[row] ?? -1
	const sdtPr = part.sdts.sdtPr[row] ?? -1
	const state = controlState(mark)

	if (content < 0) throw new DocxWriteError("missingSource", "A content control without content")

	if (!again) {
		if (state === null) out.bytes(w.bytes, document.start(element), document.openEnd(content))
		else spliceSdtStart(w, out, element, sdtPr, content, state, false)

		return
	}

	openTag(out, document, element)

	if (state !== null && sdtPr < 0) writeSdtPr(w, out, -1, state, true)

	for (let child = document.firstChildElement(element); child >= 0 && child !== content; child = document.nextSiblingElement(child)) {
		if (child === sdtPr && state !== null) writeSdtPr(w, out, sdtPr, state, true)
		else if (child === sdtPr) spliceChildren(out, part.reader, sdtPr, new Map([["id", ""]]), [])
		else copyNode(out, document, child)
	}

	openTag(out, document, content)
}

// The end of source content control `own` around inline content, from its w:sdtContent end tag.
export function closeSdtWrapper(w: StoryWriting, out: Out, own: number): void {
	const part = w.part
	const document = part.document
	const content = part.sdts.content[part.aux[own] ?? -1] ?? -1

	out.bytes(w.bytes, document.contentEnd(content), document.end(part.node(own)))
}

// A run-level control the editor made (writers of new wrappers by mark type, write/wrappers.ts).
export const NEW_CONTROL_WRAPPER: WrapperWriter = {
	type: docxSchema.marks.content_control,
	open(w, out, mark) {
		const state = controlState(mark)

		out.text(`<${w.names.el("sdt")}>`)

		if (state?.made !== undefined) writeNewSdtPr(w, out, state.made, state)
		else if (state?.copy !== undefined) writeCopiedSdtPr(w, out, state.copy, state)
		else if (state?.properties !== undefined) out.text(dataSdtPr(w, state.properties, state))
		else throw new DocxWriteError("missingSource", "A new content control without its definition")

		out.text(`<${w.names.el("sdtContent")}>`)
	},
	close(w, out) {
		out.text(`</${w.names.el("sdtContent")}></${w.names.el("sdt")}>`)
	}
}

// ---- legacy form fields ---------------------------------------------------------------------------------

// Whether a field node is a legacy form field whose value a form command set.
export function legacyFieldEdited(node: Node): boolean {
	return (
		LEGACY_FIELD_TYPES.has(node.attrs["type"] as string) &&
		(node.attrs["state"] ?? null) !== null &&
		src(node) !== NO_SOURCE &&
		(node.attrs["end"] as number) !== NO_SOURCE
	)
}

// The w:ffData a copy of a legacy form field writes in its begin w:fldChar (with its state set), or "" for any
// other field.
export function legacyFieldCopyData(names: Names, node: Node): string {
	const state = (node.attrs["state"] ?? null) as LegacyFieldState | null
	const data = state?.data

	if (data === undefined || src(node) !== NO_SOURCE || !LEGACY_FIELD_TYPES.has(node.attrs["type"] as string)) return ""

	return dataMarkup(names, withState(data, state ?? {}))
}

// w:checked last in w:checkBox, w:result first in w:ddList (CT_FFCheckBox, CT_FFDDList).
function withState(data: FormFieldData, state: LegacyFieldState): FormFieldData {
	if (state.checked === undefined && state.result === undefined) return data

	return {
		...data,
		children: data.children.map(child => {
			if (child.name === "checkBox" && state.checked !== undefined)
				return {
					...child,
					children: [...child.children.filter(inner => inner.name !== "checked"), leaf("checked", state.checked ? "1" : "0")]
				}

			if (child.name === "ddList" && state.result !== undefined)
				return {
					...child,
					children: [leaf("result", String(state.result)), ...child.children.filter(inner => inner.name !== "result")]
				}

			return child
		})
	}
}

function leaf(name: string, val: string): FormFieldData {
	return { name, attrs: [["val", val]], children: [] }
}

const XML_NAME = /^[A-Za-z_][\w.-]*$/

function dataMarkup(names: Names, data: FormFieldData): string {
	if (!XML_NAME.test(data.name) || data.attrs.some(([name]) => !XML_NAME.test(name)))
		throw new DocxWriteError("invalidValue", `A form field's w:ffData: ${JSON.stringify(data.name)}`)

	const open = `<${names.el(data.name)}${data.attrs.map(([name, value]) => ` ${names.attr(name)}="${escapeAttribute(value)}"`).join("")}`

	return data.children.length === 0
		? `${open}/>`
		: `${open}>${data.children.map(child => dataMarkup(names, child)).join("")}</${names.el(data.name)}>`
}

// A legacy form field whose value a form command set: its runs from w:fldChar begin to end as the source has
// them, with w:ffData's w:checkBox/w:checked or w:ddList/w:result set and, for a text field, its result runs
// replaced by one run of the new text (in the first result run's properties). `restyle`: the run properties
// the field's formatting gives a source run (`fresh`: the new result run modelled on it), as the field writer
// gives them (write/atoms/fields.ts), when the field's formatting changed.
export function writeLegacyFormField(w: StoryWriting, out: Out, node: Node, restyle?: (run: number, fresh: boolean) => string): void {
	const part = w.part
	const document = part.document
	const reader = part.reader
	const names = w.names
	const begin = src(node)
	const end = node.attrs["end"] as number
	const state = (node.attrs["state"] ?? {}) as LegacyFieldState
	const ffData = formFieldData(part, begin)

	if (begin === NO_SOURCE || end === NO_SOURCE || ffData < 0) throw new DocxWriteError("missingSource", "A form field without its source")

	const field = part.fieldOf(begin + 1)
	const separate = field < 0 ? -1 : (part.fields.separate[field] ?? -1)
	const from = part.start(begin)
	const to = part.byteEnd(end)
	// Source bytes [start, stop), each run starting in them with the properties `restyle` gives it.
	const copy = (start: number, stop: number): void => {
		let at = start

		if (restyle !== undefined) {
			for (let item = begin; item <= end && item < part.count; item++) {
				if (part.kinds[item] !== Item.Run || document.isSelfClosing(part.node(item))) continue

				const openEnd = document.openEnd(part.node(item))

				if (openEnd <= at || openEnd > stop) continue

				const rPr = part.runs.rPr[part.aux[item] ?? -1] ?? -1

				w.copySource(out, at, openEnd, false)
				out.text(restyle(item, false))
				at = rPr >= 0 ? document.end(rPr) : openEnd
			}
		}

		w.copySource(out, at, stop, false)
	}

	copy(from, document.start(ffData))
	writeFfData(out, part, ffData, names, state)

	if (state.text === undefined || separate < 0) {
		copy(document.end(ffData), to)

		return
	}

	// The result: between the separate run and the end run.
	const separateRun = part.parent(separate)
	const endRun = end
	const resultFrom = part.byteEnd(separateRun)
	const resultTo = part.start(endRun)

	copy(document.end(ffData), resultFrom)

	let written = false
	const resultRun = (run: number, properties: number): void => {
		const rPr =
			restyle !== undefined
				? restyle(run, true)
				: properties < 0
					? ""
					: decodeUtf8(document.bytes, document.start(properties), document.end(properties))

		out.text(`<${names.el("r")}>${rPr}${resultMarkup(names, state.text ?? "")}</${names.el("r")}>`)
		written = true
	}

	const runItem = (element: number): number => {
		for (let item = separateRun; item <= end; item++) if (part.kinds[item] === Item.Run && part.node(item) === element) return item

		return separateRun
	}

	for (
		let child = document.nextSibling(part.node(separateRun));
		child >= 0 && document.start(child) < resultTo;
		child = document.nextSibling(child)
	) {
		if (document.kinds[child] === NodeKind.Element && reader.is(child, Ns.W, "r")) {
			if (!written) resultRun(runItem(child), reader.child(child, Ns.W, "rPr"))

			continue
		}

		copyNode(out, document, child)
	}

	if (!written) resultRun(separateRun, reader.child(part.node(separateRun), Ns.W, "rPr"))

	copy(resultTo, to)
}

// A text field's result: Word's five en spaces for an empty one, line feeds as w:br.
function resultMarkup(names: Names, text: string): string {
	if (text === "") return textElement(names, "     ", false)

	return text
		.split("\n")
		.map(line => (line === "" ? "" : textElement(names, line, false)))
		.join(names.empty("br"))
}

// w:ffData with the state set: w:checked in w:checkBox (after w:size/w:sizeAuto and w:default), w:result in
// w:ddList (first).
function writeFfData(out: Out, part: StoryPart, ffData: number, names: Names, state: LegacyFieldState): void {
	const document = part.document
	const reader = part.reader

	openTag(out, document, ffData)

	for (let child = document.firstChild(ffData); child >= 0; child = document.nextSibling(child)) {
		const element = document.kinds[child] === NodeKind.Element

		if (element && reader.is(child, Ns.W, "checkBox") && state.checked !== undefined) {
			openTag(out, document, child)

			for (let inner = document.firstChild(child); inner >= 0; inner = document.nextSibling(inner)) {
				if (document.kinds[inner] === NodeKind.Element && reader.is(inner, Ns.W, "checked")) continue

				copyNode(out, document, inner)
			}

			out.text(names.val("checked", state.checked ? "1" : "0"))
			closeElement(out, part, child)

			continue
		}

		if (element && reader.is(child, Ns.W, "ddList") && state.result !== undefined) {
			openTag(out, document, child)
			out.text(names.val("result", String(state.result)))

			for (let inner = document.firstChild(child); inner >= 0; inner = document.nextSibling(inner)) {
				if (document.kinds[inner] === NodeKind.Element && reader.is(inner, Ns.W, "result")) continue

				copyNode(out, document, inner)
			}

			closeElement(out, part, child)

			continue
		}

		copyNode(out, document, child)
	}

	closeElement(out, part, ffData)
}
