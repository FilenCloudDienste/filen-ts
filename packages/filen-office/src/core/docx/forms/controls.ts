import type { Mark, Node } from "prosemirror-model"
import { nextCluster } from "../../text/index"
import { NodeKind } from "../../xml/index"
import type { ElementData } from "../edit/copies"
import { Ns } from "../model/namespaces"
import type { StoryPart } from "../model/index"
import { NO_SOURCE } from "../edit/schema"
import { formatControlDate, parseControlDate } from "./dates"

// Content controls (w:sdt, ECMA-376 Part 1 §17.5.2) as the editor sees them: the control's properties
// (w:sdtPr) read once per control from the source bytes, with what form commands changed on top. The changes
// live in the `state` attribute of the block `sdt` node or the run-level `content_control` mark
// (ControlState); a control the editor made carries its whole definition there (`made`).

export type ControlType =
	| "plainText"
	| "richText"
	| "checkbox"
	| "dropDownList"
	| "comboBox"
	| "date"
	| "picture"
	| "repeatingSection"
	| "repeatingSectionItem"
	| "group"
	| "buildingBlock"
	| "other"

export type ControlLock = "sdtLocked" | "contentLocked" | "sdtContentLocked" | "unlocked"

export interface ControlListItem {
	// w:displayText (the value when absent) and w:value.
	readonly text: string
	readonly value: string
	// Written without w:displayText (Word's "Choose an item." entry): the value is what shows.
	readonly valueOnly?: true
}

// w14:checkbox (MS-DOCX §2.6.1.2): the state and the glyph of each state (a code point in a font).
export interface ControlCheckbox {
	readonly checked: boolean
	readonly checkedChar: number
	readonly checkedFont: string | null
	readonly uncheckedChar: number
	readonly uncheckedFont: string | null
}

// w:date (§17.5.2.7): the date shown (w:fullDate, as yyyy-mm-dd), how it is shown and how a binding stores it.
export interface ControlDate {
	readonly iso: string | null
	readonly format: string | null
	readonly lid: string | null
	readonly calendar: string | null
	readonly storeAs: "dateTime" | "date" | "text"
}

// w:dataBinding (§17.5.2.6).
export interface ControlBinding {
	readonly xpath: string
	readonly prefixMappings: string
	readonly storeItemID: string
}

export interface ControlInfo {
	readonly type: ControlType
	readonly id: string | null
	readonly tag: string | null
	readonly alias: string | null
	readonly lock: ControlLock
	// w:placeholder/w:docPart and w:showingPlcHdr: the content is the placeholder text.
	readonly docPart: string | null
	readonly showingPlaceholder: boolean
	// w:temporary: the control goes once its content is edited.
	readonly temporary: boolean
	// w:text w:multiLine.
	readonly multiLine: boolean
	readonly checkbox: ControlCheckbox | null
	// List entries of a drop-down list or combo box, and w:lastValue.
	readonly items: readonly ControlListItem[]
	readonly lastValue: string | null
	readonly date: ControlDate | null
	readonly binding: ControlBinding | null
	// w15:dataBinding (a rich text or repeating section binding): bound in a way the editor does not update.
	readonly richBinding: boolean
	// A repeating section whose items cannot be added or removed (w15:doNotAllowInsertDeleteSection).
	readonly fixedItems: boolean
}

// What form commands set on a control (null fields: as the source has it).
export interface ControlState {
	readonly checked?: boolean
	// The chosen list entry's value (w:lastValue); null: free text in a combo box.
	readonly value?: string | null
	// yyyy-mm-dd (w:fullDate); null: no date.
	readonly date?: string | null
	// Whether the content is the placeholder text (w:showingPlcHdr).
	readonly placeholder?: boolean
	// A list's entries as control.items set them (a source control's; a made control's are its definition's).
	readonly items?: readonly ControlListItem[]
	// A control the editor made (never a source one): its definition.
	readonly made?: MadeControl
	// A copy of source control `copy` (an item a repeating section added): its properties are the source's,
	// with `id` telling it from other copies (w:id is left out of a copy).
	readonly copy?: number
	readonly id?: string
	// A copy of another part's control: that control's w:sdtPr without its w:id, as data.
	readonly properties?: ElementData
}

// A control the editor inserts (control.insert), written new: w:id is a fresh random id.
export interface MadeControl {
	readonly type: Exclude<ControlType, "group" | "buildingBlock" | "other">
	readonly id: string
	readonly items?: readonly ControlListItem[]
	readonly dateFormat?: string
	readonly lid?: string
}

// Word's checkbox glyphs (MS-DOCX §2.6.1.2: the defaults of w14:checkedState and w14:uncheckedState).
export const CHECKED_GLYPH = 0x2612
export const UNCHECKED_GLYPH = 0x2610
export const GLYPH_FONT = "MS Gothic"

// The placeholder texts of Word's default building blocks (DefaultPlaceholder_*), by control type.
export const DEFAULT_PLACEHOLDERS: Readonly<Record<string, string>> = {
	text: "Click or tap here to enter text.",
	date: "Click or tap to enter a date.",
	list: "Choose an item."
}

export function defaultPlaceholder(type: ControlType): string {
	return type === "date"
		? (DEFAULT_PLACEHOLDERS["date"] ?? "")
		: type === "dropDownList" || type === "comboBox"
			? (DEFAULT_PLACEHOLDERS["list"] ?? "")
			: (DEFAULT_PLACEHOLDERS["text"] ?? "")
}

const LOCKS = new Set<ControlLock>(["sdtLocked", "contentLocked", "sdtContentLocked", "unlocked"])
const STORE_AS = new Set(["dateTime", "date", "text"])

// Controls read from a part, by sdt item.
const read = new WeakMap<StoryPart, Map<number, ControlInfo>>()

// The control of source sdt item `item` of `part` as written.
export function sourceControl(part: StoryPart, item: number): ControlInfo {
	let cache = read.get(part)

	if (cache === undefined) {
		cache = new Map()
		read.set(part, cache)
	}

	let info = cache.get(item)

	if (info === undefined) {
		info = readControl(part, part.sdts.sdtPr[part.aux[item] ?? -1] ?? -1)
		cache.set(item, info)
	}

	return info
}

function hexChar(value: string | undefined, fallback: number): number {
	const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 16)

	return Number.isInteger(parsed) && parsed > 0 && parsed <= 0x10ffff ? parsed : fallback
}

// The date part of an xsd:dateTime (w:fullDate), or null.
export function isoDate(value: string | undefined): string | null {
	const match = value === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(value)

	return match === null ? null : `${match[1]}-${match[2]}-${match[3]}`
}

function readControl(part: StoryPart, sdtPr: number): ControlInfo {
	const reader = part.reader
	const document = part.document
	let type: ControlType = "richText"
	let typed = false
	let id: string | null = null
	let tag: string | null = null
	let alias: string | null = null
	let lock: ControlLock = "unlocked"
	let docPart: string | null = null
	let showingPlaceholder = false
	let temporary = false
	let multiLine = false
	let checkbox: ControlCheckbox | null = null
	let items: ControlListItem[] = []
	let lastValue: string | null = null
	let date: ControlDate | null = null
	let binding: ControlBinding | null = null
	let richBinding = false
	let fixedItems = false
	const setType = (value: ControlType): void => {
		if (!typed) type = value

		typed = true
	}

	for (let child = sdtPr < 0 ? -1 : document.firstChildElement(sdtPr); child >= 0; child = document.nextSiblingElement(child)) {
		const group = reader.group(child)
		const local = document.localName(child)

		if (group === Ns.W) {
			switch (local) {
				case "id":
					id = reader.attr(child, Ns.W, "val") ?? null
					break
				case "tag":
					tag = reader.attr(child, Ns.W, "val") ?? null
					break
				case "alias":
					alias = reader.attr(child, Ns.W, "val") ?? null
					break
				case "lock": {
					const value = reader.attr(child, Ns.W, "val") as ControlLock | undefined

					lock = value !== undefined && LOCKS.has(value) ? value : "unlocked"
					break
				}
				case "placeholder": {
					const part = reader.child(child, Ns.W, "docPart")

					docPart = part < 0 ? null : (reader.attr(part, Ns.W, "val") ?? null)
					break
				}
				case "showingPlcHdr":
					showingPlaceholder = reader.onOff(child)
					break
				case "temporary":
					temporary = reader.onOff(child)
					break
				case "dataBinding":
					binding = {
						xpath: reader.attr(child, Ns.W, "xpath") ?? "",
						prefixMappings: reader.attr(child, Ns.W, "prefixMappings") ?? "",
						storeItemID: reader.attr(child, Ns.W, "storeItemID") ?? ""
					}
					break
				case "text":
					setType("plainText")
					multiLine = reader.flag(child, Ns.W, "multiLine")
					break
				case "richText":
					setType("richText")
					break
				case "picture":
					setType("picture")
					break
				case "group":
					setType("group")
					break
				case "docPartObj":
				case "docPartList":
					setType("buildingBlock")
					break
				case "citation":
				case "bibliography":
				case "equation":
					setType("other")
					break
				case "dropDownList":
				case "comboBox": {
					setType(local)
					lastValue = reader.attr(child, Ns.W, "lastValue") ?? null
					items = []

					for (let entry = document.firstChildElement(child); entry >= 0; entry = document.nextSiblingElement(entry)) {
						if (!reader.is(entry, Ns.W, "listItem")) continue

						const value = reader.attr(entry, Ns.W, "value") ?? ""

						const text = reader.attr(entry, Ns.W, "displayText")

						items.push(text === undefined ? { text: value, value, valueOnly: true } : { text, value })
					}

					break
				}
				case "date": {
					setType("date")

					const option = (name: string): string | null => {
						const node = reader.child(child, Ns.W, name)

						return node < 0 ? null : (reader.attr(node, Ns.W, "val") ?? null)
					}
					const storeAs = option("storeMappedDataAs")

					date = {
						iso: isoDate(reader.attr(child, Ns.W, "fullDate")),
						format: option("dateFormat"),
						lid: option("lid"),
						calendar: option("calendar"),
						storeAs: storeAs !== null && STORE_AS.has(storeAs) ? (storeAs as ControlDate["storeAs"]) : "dateTime"
					}
					break
				}
			}
		} else if (group === Ns.W14 && local === "checkbox") {
			setType("checkbox")

			const state = (name: string, fallback: number): { char: number; font: string | null } => {
				const node = reader.child(child, Ns.W14, name)

				return node < 0
					? { char: fallback, font: GLYPH_FONT }
					: { char: hexChar(reader.attr(node, Ns.W14, "val"), fallback), font: reader.attr(node, Ns.W14, "font") ?? null }
			}
			const checkedNode = reader.child(child, Ns.W14, "checked")
			const checkedValue = checkedNode < 0 ? undefined : reader.attr(checkedNode, Ns.W14, "val")
			const on = state("checkedState", CHECKED_GLYPH)
			const off = state("uncheckedState", UNCHECKED_GLYPH)

			checkbox = {
				checked: checkedNode >= 0 && checkedValue !== "0" && checkedValue !== "false" && checkedValue !== "off",
				checkedChar: on.char,
				checkedFont: on.font,
				uncheckedChar: off.char,
				uncheckedFont: off.font
			}
		} else if (group === Ns.W15) {
			switch (local) {
				case "repeatingSection":
					setType("repeatingSection")
					fixedItems = reader.child(child, Ns.W15, "doNotAllowInsertDeleteSection") >= 0
					break
				case "repeatingSectionItem":
					setType("repeatingSectionItem")
					break
				case "dataBinding":
					richBinding = true
					break
			}
		}
	}

	return {
		type,
		id,
		tag,
		alias,
		lock,
		docPart,
		showingPlaceholder,
		temporary,
		multiLine,
		checkbox,
		items,
		lastValue,
		date,
		binding,
		richBinding,
		fixedItems
	}
}

const W14_URI = "http://schemas.microsoft.com/office/word/2010/wordml"
const W15_URI = "http://schemas.microsoft.com/office/word/2012/wordml"
const MAIN_DATA = "w"
const fromData = new WeakMap<ElementData, ControlInfo>()

function sdtValue(data: ElementData | undefined, uri: string, name: string): string | undefined {
	return data?.attrs.find(([own, local]) => own === uri && local === name)?.[2]
}

function sdtChild(data: ElementData | undefined, uri: string, name: string): ElementData | undefined {
	return data?.children.find(child => child.uri === uri && child.name === name)
}

// ST_OnOff: no w:val is on.
function sdtOn(data: ElementData, uri = MAIN_DATA): boolean {
	const value = sdtValue(data, uri, "val")

	return value === undefined || !(value === "0" || value === "false" || value === "off")
}

// The control a copy of another part's control stands for: its w:sdtPr kept as data (edit/copies.ts), read as
// readControl reads the source's.
function dataControl(sdtPr: ElementData): ControlInfo {
	let info = fromData.get(sdtPr)

	if (info !== undefined) return info

	let type: ControlType = "richText"
	let typed = false
	const setType = (value: ControlType): void => {
		if (!typed) type = value

		typed = true
	}
	const base: { -readonly [K in keyof ControlInfo]: ControlInfo[K] } = { ...madeControl({ type: "richText", id: "" }), id: null }

	for (const child of sdtPr.children) {
		const val = (): string | null => sdtValue(child, MAIN_DATA, "val") ?? null

		if (child.uri === MAIN_DATA) {
			switch (child.name) {
				case "id":
					base.id = val()
					break
				case "tag":
					base.tag = val()
					break
				case "alias":
					base.alias = val()
					break
				case "lock": {
					const value = val() as ControlLock | null

					base.lock = value !== null && LOCKS.has(value) ? value : "unlocked"
					break
				}
				case "placeholder":
					base.docPart = sdtValue(sdtChild(child, MAIN_DATA, "docPart"), MAIN_DATA, "val") ?? null
					break
				case "showingPlcHdr":
					base.showingPlaceholder = sdtOn(child)
					break
				case "temporary":
					base.temporary = sdtOn(child)
					break
				case "dataBinding":
					base.binding = {
						xpath: sdtValue(child, MAIN_DATA, "xpath") ?? "",
						prefixMappings: sdtValue(child, MAIN_DATA, "prefixMappings") ?? "",
						storeItemID: sdtValue(child, MAIN_DATA, "storeItemID") ?? ""
					}
					break
				case "text":
					setType("plainText")
					base.multiLine = ["1", "true", "on"].includes(sdtValue(child, MAIN_DATA, "multiLine") ?? "")
					break
				case "richText":
				case "picture":
				case "group":
					setType(child.name)
					break
				case "docPartObj":
				case "docPartList":
					setType("buildingBlock")
					break
				case "citation":
				case "bibliography":
				case "equation":
					setType("other")
					break
				case "dropDownList":
				case "comboBox":
					setType(child.name)
					base.lastValue = sdtValue(child, MAIN_DATA, "lastValue") ?? null
					base.items = child.children
						.filter(entry => entry.uri === MAIN_DATA && entry.name === "listItem")
						.map(entry => {
							const value = sdtValue(entry, MAIN_DATA, "value") ?? ""

							const text = sdtValue(entry, MAIN_DATA, "displayText")

							return text === undefined ? { text: value, value, valueOnly: true as const } : { text, value }
						})
					break
				case "date": {
					setType("date")

					const option = (name: string): string | null => sdtValue(sdtChild(child, MAIN_DATA, name), MAIN_DATA, "val") ?? null
					const storeAs = option("storeMappedDataAs")

					base.date = {
						iso: isoDate(sdtValue(child, MAIN_DATA, "fullDate")),
						format: option("dateFormat"),
						lid: option("lid"),
						calendar: option("calendar"),
						storeAs: storeAs !== null && STORE_AS.has(storeAs) ? (storeAs as ControlDate["storeAs"]) : "dateTime"
					}
					break
				}
			}
		} else if (child.uri === W14_URI && child.name === "checkbox") {
			setType("checkbox")

			const state = (name: string, fallback: number): { char: number; font: string | null } => {
				const node = sdtChild(child, W14_URI, name)

				return node === undefined
					? { char: fallback, font: GLYPH_FONT }
					: { char: hexChar(sdtValue(node, W14_URI, "val"), fallback), font: sdtValue(node, W14_URI, "font") ?? null }
			}
			const checked = sdtChild(child, W14_URI, "checked")
			const on = state("checkedState", CHECKED_GLYPH)
			const off = state("uncheckedState", UNCHECKED_GLYPH)

			base.checkbox = {
				checked: checked !== undefined && sdtOn(checked, W14_URI),
				checkedChar: on.char,
				checkedFont: on.font,
				uncheckedChar: off.char,
				uncheckedFont: off.font
			}
		} else if (child.uri === W15_URI) {
			if (child.name === "repeatingSection") {
				setType("repeatingSection")
				base.fixedItems = sdtChild(child, W15_URI, "doNotAllowInsertDeleteSection") !== undefined
			} else if (child.name === "repeatingSectionItem") setType("repeatingSectionItem")
			else if (child.name === "dataBinding") base.richBinding = true
		}
	}

	info = Object.freeze({ ...base, type })
	fromData.set(sdtPr, info)

	return info
}

const NO_ITEMS: readonly ControlListItem[] = Object.freeze([])

// The definition of a control the editor made, as ControlInfo.
function madeControl(made: MadeControl): ControlInfo {
	return {
		type: made.type,
		id: made.id,
		tag: null,
		alias: null,
		lock: "unlocked",
		docPart: null,
		showingPlaceholder: false,
		temporary: false,
		multiLine: false,
		checkbox:
			made.type === "checkbox"
				? {
						checked: false,
						checkedChar: CHECKED_GLYPH,
						checkedFont: GLYPH_FONT,
						uncheckedChar: UNCHECKED_GLYPH,
						uncheckedFont: GLYPH_FONT
					}
				: null,
		items: made.items ?? NO_ITEMS,
		lastValue: null,
		date:
			made.type === "date"
				? { iso: null, format: made.dateFormat ?? null, lid: made.lid ?? null, calendar: "gregorian", storeAs: "dateTime" }
				: null,
		binding: null,
		richBinding: false,
		fixedItems: false
	}
}

export function controlState(holder: Node | Mark): ControlState | null {
	return (holder.attrs["state"] as ControlState | null | undefined) ?? null
}

// The control a `sdt` node or `content_control` mark of `part` stands for, with its state applied; undefined
// for a new control without a definition (not one the editor made).
export function controlOf(part: StoryPart, holder: Node | Mark): ControlInfo | undefined {
	const state = controlState(holder)
	const base = baseOf(part, holder.attrs["src"] as number, state)

	return base === undefined || state === null ? base : withState(base, state)
}

const applied = new WeakMap<ControlInfo, WeakMap<ControlState, ControlInfo>>()

const made = new WeakMap<MadeControl, ControlInfo>()

function baseOf(part: StoryPart, own: number, state: ControlState | null): ControlInfo | undefined {
	if (own === NO_SOURCE && state?.copy !== undefined)
		return state.copy >= 0 && state.copy < part.count ? sourceControl(part, state.copy) : undefined
	if (own === NO_SOURCE && state?.properties !== undefined) return dataControl(state.properties)
	if (state?.made !== undefined) {
		let info = made.get(state.made)

		if (info === undefined) {
			info = madeControl(state.made)
			made.set(state.made, info)
		}

		return info
	}
	if (own === NO_SOURCE || own >= part.count) return undefined

	return sourceControl(part, own)
}

function withState(base: ControlInfo, state: ControlState): ControlInfo {
	let byState = applied.get(base)

	if (byState === undefined) {
		byState = new WeakMap()
		applied.set(base, byState)
	}

	let info = byState.get(state)

	if (info === undefined) {
		info = {
			...base,
			showingPlaceholder: state.placeholder ?? base.showingPlaceholder,
			checkbox: base.checkbox === null || state.checked === undefined ? base.checkbox : { ...base.checkbox, checked: state.checked },
			lastValue: state.value === undefined ? base.lastValue : state.value,
			items: state.items ?? base.items,
			date: base.date === null || state.date === undefined ? base.date : { ...base.date, iso: state.date }
		}
		byState.set(state, info)
	}

	return info
}

const placeholders = new WeakMap<StoryPart, Map<number, string>>()

// The placeholder text of a control: its source content when the source shows the placeholder (the text of
// the building block w:docPart names, as Word copied it in), else the text of Word's default placeholder for
// the type.
export function placeholderText(part: StoryPart, holder: Node | Mark, info: ControlInfo): string {
	const src = holder.attrs["src"] as number
	// A copy (a repeating section item added) has its source's placeholder.
	const own = src === NO_SOURCE ? (controlState(holder)?.copy ?? NO_SOURCE) : src

	if (own === NO_SOURCE || own >= part.count || !sourceControl(part, own).showingPlaceholder) return defaultPlaceholder(info.type)

	let cache = placeholders.get(part)

	if (cache === undefined) {
		cache = new Map()
		placeholders.set(part, cache)
	}

	let text = cache.get(own)

	if (text === undefined) {
		text = contentText(part, part.sdts.content[part.aux[own] ?? -1] ?? -1)

		if (text === "") text = defaultPlaceholder(info.type)

		cache.set(own, text)
	}

	return text
}

// The text of a w:sdtContent's runs (w:t, tabs as tab characters), its first paragraph's only.
function contentText(part: StoryPart, content: number): string {
	if (content < 0) return ""

	const document = part.document
	const reader = part.reader
	const end = document.end(content)
	let out = ""
	let paragraphs = 0

	for (let node = content + 1; node < document.count && document.start(node) < end; node++) {
		if (document.kinds[node] !== NodeKind.Element || reader.group(node) !== Ns.W) continue

		const local = document.localName(node)

		if (local === "p" && ++paragraphs > 1) break
		if (local === "t") out += reader.text(node)
		else if (local === "tab") out += "\t"
		else if (local === "delText" || local === "instrText") continue
	}

	return out
}

// The text a checkbox shows for `checked`, and its font.
export function checkboxGlyph(checkbox: ControlCheckbox, checked: boolean): { readonly text: string; readonly font: string | null } {
	return checked
		? { text: String.fromCodePoint(checkbox.checkedChar), font: checkbox.checkedFont }
		: { text: String.fromCodePoint(checkbox.uncheckedChar), font: checkbox.uncheckedFont }
}

// The list entry with `value`, or undefined.
export function listItem(info: ControlInfo, value: string): ControlListItem | undefined {
	return info.items.find(item => item.value === value)
}

// A fresh w:id for a control the editor makes: a random signed 32-bit integer other than 0, as Word writes.
export function newControlId(random: () => number = Math.random): string {
	for (;;) {
		const id = Math.floor(random() * 0x100000000) - 0x80000000

		if (id !== 0) return String(id)
	}
}

// ---- bindings (ECMA-376 Part 1 §17.5.2.6 w:dataBinding; see binding.ts) ------------------------------

export interface BindingStep {
	// Namespace URI ("" for none) and local name; `index` is the 1-based position among same-named siblings.
	readonly uri: string
	readonly local: string
	readonly index: number
}

export interface SimpleBinding {
	// The w:storeItemID, upper case without braces.
	readonly store: string
	readonly steps: readonly BindingStep[]
	// One string per bound node (for controls bound to the same node).
	readonly key: string
}

const STEP = /^(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)(?:\[(\d{1,6})\])?$/
const MAPPING = /xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:'([^']*)'|"([^"]*)")/g

export function storeId(value: string): string {
	return value
		.trim()
		.replace(/^\{|\}$/g, "")
		.toUpperCase()
}

// w:prefixMappings: prefix -> namespace URI.
export function prefixMappings(value: string): Map<string, string> {
	const out = new Map<string, string>()

	for (const match of value.matchAll(MAPPING)) out.set(match[1] ?? "", match[2] ?? match[3] ?? "")

	return out
}

const parsed = new WeakMap<ControlBinding, SimpleBinding | null>()

// The binding as a path the editor updates, or undefined when it cannot.
export function simpleBinding(binding: ControlBinding): SimpleBinding | undefined {
	let found = parsed.get(binding)

	if (found === undefined) {
		found = parseBinding(binding) ?? null
		parsed.set(binding, found)
	}

	return found ?? undefined
}

function parseBinding(binding: ControlBinding): SimpleBinding | undefined {
	const store = storeId(binding.storeItemID)
	const xpath = binding.xpath.trim()

	if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(store) || !xpath.startsWith("/") || xpath.startsWith("//"))
		return undefined

	const mappings = prefixMappings(binding.prefixMappings)
	const steps: BindingStep[] = []

	for (const text of xpath.slice(1).split("/")) {
		const match = STEP.exec(text)

		if (match === null) return undefined

		const prefix = match[1]
		const uri = prefix === undefined ? "" : mappings.get(prefix)
		const index = match[3] === undefined ? 1 : Number(match[3])

		if (uri === undefined || index < 1) return undefined

		steps.push({ uri, local: match[2] ?? "", index })
	}

	return { store, steps, key: `${store}|${steps.map(step => `{${step.uri}}${step.local}[${String(step.index)}]`).join("/")}` }
}

// Why a control's content cannot be edited because of its binding, or undefined.
export function boundReason(info: ControlInfo): "bound" | undefined {
	if (info.richBinding) return "bound"
	if (info.binding === null) return undefined

	return simpleBinding(info.binding) === undefined ? "bound" : undefined
}

// ---- controls at a position -----------------------------------------------------------------------------

// A control around a range of a story's document: a block `sdt` (content between its start and end tokens) or
// a run of inline content carrying a `content_control` mark.
export interface ControlAround {
	readonly kind: "block" | "inline"
	readonly holder: Node | Mark
	readonly info: ControlInfo
	// The content: inside the block, or the span of the inline content.
	readonly from: number
	readonly to: number
	// The block's position (the inline span's start for an inline control).
	readonly pos: number
}

// One control per content control mark: a source one by its item, a made one by its w:id.
export function controlKey(holder: Node | Mark): string {
	const own = holder.attrs["src"] as number

	if (own !== NO_SOURCE) return `s${String(own)}`

	const state = controlState(holder)

	return `m${state?.made?.id ?? state?.id ?? ""}`
}

function controlMarks(node: Node): readonly Mark[] {
	return node.marks.filter(mark => mark.type.name === "content_control")
}

// The span [from, to] of the inline content around `at` (a child index range of `paragraph`, content starting
// at `start`) carrying control `key`.
function spanOf(
	paragraph: Node,
	start: number,
	first: number,
	last: number,
	key: string
): { from: number; to: number; mark: Mark } | undefined {
	const has = (index: number): Mark | undefined =>
		index < 0 || index >= paragraph.childCount ? undefined : controlMarks(paragraph.child(index)).find(mark => controlKey(mark) === key)
	const atFirst = has(first)
	const mark = atFirst ?? has(last)

	if (mark === undefined) return undefined

	// From a node that carries it (with an empty range, only one side may).
	let from = atFirst !== undefined ? first : last
	let to = atFirst !== undefined && has(last) !== undefined ? last : from

	while (from > 0 && has(from - 1) !== undefined) from--
	while (to < paragraph.childCount - 1 && has(to + 1) !== undefined) to++

	let pos = start
	let fromPos = start
	let toPos = start

	for (let index = 0; index <= to; index++) {
		if (index === from) fromPos = pos

		pos += paragraph.child(index).nodeSize

		if (index === to) toPos = pos
	}

	return { from: fromPos, to: toPos, mark }
}

// The innermost run-level control whose content holds [from, to] (both in one paragraph): every inline node
// the range covers carries it; an empty range touches it from either side.
export function inlineControlAround(part: StoryPart, doc: Node, from: number, to: number): ControlAround | undefined {
	const $from = doc.resolve(from)
	const paragraph = $from.parent

	if (!paragraph.inlineContent || to > $from.end() || paragraph.childCount === 0) return undefined

	const start = $from.start()
	const firstIndex = $from.index()
	// Children overlapping the range: [firstIndex, lastIndex]; an empty range sees the nodes on both sides.
	let first = firstIndex
	let last = firstIndex
	let keys: string[]

	if (from === to) {
		const before = $from.textOffset > 0 ? firstIndex : firstIndex - 1
		const after = firstIndex
		const beforeKeys = before >= 0 ? controlMarks(paragraph.child(before)).map(controlKey) : []
		const afterKeys = after < paragraph.childCount ? controlMarks(paragraph.child(after)).map(controlKey) : []

		keys = [...new Set([...beforeKeys, ...afterKeys])]
		first = beforeKeys.length > 0 ? before : after
		last = afterKeys.length > 0 && after < paragraph.childCount ? after : first
	} else {
		const $to = doc.resolve(to)

		last = $to.textOffset > 0 || $to.index() === firstIndex ? $to.index() : $to.index() - 1
		keys = []

		for (let index = first; index <= last && index < paragraph.childCount; index++) {
			const own = controlMarks(paragraph.child(index)).map(controlKey)

			keys = index === first ? own : keys.filter(key => own.includes(key))
		}
	}

	let best: ControlAround | undefined

	for (const key of keys) {
		const span = spanOf(
			paragraph,
			start,
			Math.max(0, Math.min(first, paragraph.childCount - 1)),
			Math.min(last, paragraph.childCount - 1),
			key
		)

		if (span === undefined || span.from > from || span.to < to) continue
		if (best !== undefined && span.to - span.from >= best.to - best.from) continue

		const info = controlOf(part, span.mark)

		if (info !== undefined) best = { kind: "inline", holder: span.mark, info, from: span.from, to: span.to, pos: span.from }
	}

	return best
}

// The innermost block control holding [from, to].
export function blockControlAround(part: StoryPart, doc: Node, from: number, to: number): ControlAround | undefined {
	const $from = doc.resolve(from)

	for (let depth = $from.depth; depth > 0; depth--) {
		const node = $from.node(depth)

		if (node.type.name !== "sdt") continue

		const pos = $from.before(depth)

		if (to > pos + node.nodeSize - 1) continue

		const info = controlOf(part, node)

		return info === undefined ? undefined : { kind: "block", holder: node, info, from: pos + 1, to: pos + node.nodeSize - 1, pos }
	}

	return undefined
}

// The innermost control holding [from, to] (an inline one inside a block one is the inner).
export function controlAround(part: StoryPart, doc: Node, from: number, to: number): ControlAround | undefined {
	return inlineControlAround(part, doc, from, to) ?? blockControlAround(part, doc, from, to)
}

// Why typing cannot change a control's content, or undefined: locked content (w:lock), a binding the editor
// does not update, or content that only form commands change (a checkbox, a drop-down list, a picture, a
// group, which allows edits only in the controls inside it).
export function typeable(info: ControlInfo): "contentLocked" | "bound" | "notText" | undefined {
	if (info.lock === "contentLocked" || info.lock === "sdtContentLocked") return "contentLocked"
	if (boundReason(info) !== undefined) return "bound"
	if (info.type === "checkbox" || info.type === "dropDownList" || info.type === "picture" || info.type === "group") return "notText"

	return undefined
}

// ---- legacy form fields ---------------------------------------------------------------------------------

export type LegacyFieldType = "FORMTEXT" | "FORMCHECKBOX" | "FORMDROPDOWN"

// A legacy form field (ECMA-376 Part 1 §17.16.17 w:ffData in the field's begin w:fldChar).
export interface LegacyField {
	readonly type: LegacyFieldType
	readonly name: string | null
	// w:enabled: a field without it cannot be filled in (§17.16.14).
	readonly enabled: boolean
	readonly checked: boolean
	readonly entries: readonly string[]
	// The chosen entry (w:ddList w:result, else w:default, else the first).
	readonly result: number
	// w:textInput w:type ("regular", "number", "date"...), w:maxLength (0: none) and w:format.
	readonly textType: string
	readonly maxLength: number
	readonly format: string | null
}

// A w:ffData element as data: WordprocessingML local names and attributes, what a copy of a legacy form field
// carries (its source's part holds the element).
export interface FormFieldData {
	readonly name: string
	readonly attrs: readonly (readonly [string, string])[]
	readonly children: readonly FormFieldData[]
}

// What form commands set on a legacy field (its `state`); a copy of a source field (src -1) carries its w:ffData.
export interface LegacyFieldState {
	readonly checked?: boolean
	readonly result?: number
	readonly text?: string
	readonly data?: FormFieldData
}

const LEGACY_TYPES = new Set<string>(["FORMTEXT", "FORMCHECKBOX", "FORMDROPDOWN"])
const legacy = new WeakMap<StoryPart, Map<number, LegacyField | null>>()
const copied = new WeakMap<FormFieldData, LegacyField>()

export function isLegacyFieldType(type: string): type is LegacyFieldType {
	return LEGACY_TYPES.has(type)
}

// The w:ffData element of the field whose begin run is `item`, or -1.
export function formFieldData(part: StoryPart, item: number): number {
	const field = item === NO_SOURCE || item + 1 >= part.count ? -1 : part.fieldOf(item + 1)
	const begin = field < 0 ? -1 : (part.fields.begin[field] ?? -1)

	return begin < 0 ? -1 : part.reader.child(part.node(begin), Ns.W, "ffData")
}

// The WordprocessingML content of XML element `node` of `part` as data (anything else is left out).
function elementData(part: StoryPart, node: number): FormFieldData {
	const document = part.document
	const reader = part.reader
	const attrs: [string, string][] = []
	const children: FormFieldData[] = []

	for (const { name, value } of document.attributes(node)) {
		const local = name.slice(name.indexOf(":") + 1)

		if (reader.attr(node, Ns.W, local) === value) attrs.push([local, value])
	}

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.group(child) === Ns.W) children.push(elementData(part, child))
	}

	return { name: document.localName(node), attrs, children }
}

// The w:ffData of the legacy form field whose begin run is `item`, as data.
export function legacyFieldData(part: StoryPart, item: number): FormFieldData | undefined {
	const ffData = formFieldData(part, item)

	return ffData < 0 ? undefined : elementData(part, ffData)
}

function dataChild(data: FormFieldData | undefined, name: string): FormFieldData | undefined {
	return data?.children.find(child => child.name === name)
}

function dataAttr(data: FormFieldData | undefined, name: string): string | undefined {
	return data?.attrs.find(([key]) => key === name)?.[1]
}

function readLegacy(type: LegacyFieldType, ffData: FormFieldData): LegacyField {
	const val = (data: FormFieldData | undefined, name: string): string | undefined => {
		const child = dataChild(data, name)

		return child === undefined ? undefined : (dataAttr(child, "val") ?? "")
	}
	// ST_OnOff: no w:val is on.
	const on = (data: FormFieldData | undefined, name: string): boolean | undefined => {
		const child = dataChild(data, name)
		const value = child === undefined ? undefined : dataAttr(child, "val")

		return child === undefined ? undefined : value === undefined || !(value === "0" || value === "false" || value === "off")
	}
	const checkBox = dataChild(ffData, "checkBox")
	const ddList = dataChild(ffData, "ddList")
	const textInput = dataChild(ffData, "textInput")
	const entries = (ddList?.children ?? []).filter(child => child.name === "listEntry").map(child => dataAttr(child, "val") ?? "")
	const result = Number.parseInt(val(ddList, "result") ?? val(ddList, "default") ?? "0", 10)

	return {
		type,
		name: val(ffData, "name") ?? null,
		enabled: on(ffData, "enabled") ?? false,
		checked: on(checkBox, "checked") ?? on(checkBox, "default") ?? false,
		entries,
		result: Number.isInteger(result) && result >= 0 && result < entries.length ? result : 0,
		textType: textInput === undefined ? "regular" : (val(textInput, "type") ?? "regular"),
		maxLength: Math.max(0, Number.parseInt(val(textInput, "maxLength") ?? "0", 10) || 0),
		format: val(textInput, "format") ?? null
	}
}

// The legacy form field a `field` node stands for, with its state applied; undefined for other fields.
export function legacyFieldOf(part: StoryPart, node: Node): LegacyField | undefined {
	const type = node.attrs["type"] as string
	const own = node.attrs["src"] as number

	if (!isLegacyFieldType(type)) return undefined

	const state = (node.attrs["state"] as LegacyFieldState | null | undefined) ?? null
	let field: LegacyField | null | undefined

	if (own === NO_SOURCE) {
		const data = state?.data

		if (data === undefined) return undefined

		field = copied.get(data)

		if (field === undefined) {
			field = readLegacy(type, data)
			copied.set(data, field)
		}
	} else {
		if (own >= part.count) return undefined

		let cache = legacy.get(part)

		if (cache === undefined) {
			cache = new Map()
			legacy.set(part, cache)
		}

		field = cache.get(own)

		if (field === undefined) {
			const data = legacyFieldData(part, own)

			field = data === undefined ? null : readLegacy(type, data)
			cache.set(own, field)
		}
	}

	if (field === null) return undefined

	return state === null ? field : { ...field, checked: state.checked ?? field.checked, result: state.result ?? field.result }
}

// The state a copy of legacy form field `node` (built from `part`) carries: its own with the source's w:ffData,
// so the copy is the same form field. Word keeps a pasted copy's w:ffData, its w:name too, and leaves the bookmark
// of that name with the original (Word 16 output in the public corpus, SHA-256
// 69503abc2caecf0a854a1151a3f3e30bf7cfd1de7af88e33313ff9eced7e47d4: ten fields named Check4, one bookmark).
// Undefined for other fields.
export function legacyCopyState(part: StoryPart, node: Node): LegacyFieldState | undefined {
	const own = node.attrs["src"] as number
	const state = (node.attrs["state"] as LegacyFieldState | null | undefined) ?? {}

	if (!isLegacyFieldType(node.attrs["type"] as string) || own === NO_SOURCE || own >= part.count) return undefined

	const data = legacyFieldData(part, own)

	return data === undefined ? undefined : { ...state, data }
}

// Text form fields Word fills in itself (ECMA-376 Part 1 §17.16.34 ST_FFTextType): the current date or time,
// a calculation.
const COMPUTED_TEXT = new Set(["currentDate", "currentTime", "calculated"])

export function typableField(field: LegacyField): boolean {
	return field.type === "FORMTEXT" && !COMPUTED_TEXT.has(field.textType)
}

// The date picture of a date field without w:format (Word's en-US short date).
const DEFAULT_FIELD_DATE = "M/d/yyyy"

// The first `count` user-perceived characters of `text` (w:maxLength counts characters, not UTF-16 units): the
// layout's grapheme clusters, the same with or without Intl.Segmenter.
function firstCharacters(text: string, count: number): string {
	let end = 0

	for (let taken = 0; taken < count && end < text.length; taken++) end = nextCluster(text, end, text.length)

	return text.slice(0, end)
}

// A number picture (w:format of a number field, a Word numeric picture: 0 and # digits, a "," grouping digits,
// "." the decimals, "%" a percentage, ";" a negative section, anything else literal) applied to `value`.
function formatNumber(value: number, picture: string): string {
	const sections = picture.split(";")
	const negative = value < 0 && sections.length > 1
	const section = (negative ? sections[1] : sections[0]) ?? ""
	const first = section.search(/[0#]/)
	const last = Math.max(section.lastIndexOf("0"), section.lastIndexOf("#"))

	if (first < 0) return section

	const body = section.slice(first, last + 1)
	const dot = body.indexOf(".")
	const decimals = dot < 0 ? 0 : body.slice(dot + 1).replace(/[^0#]/g, "").length
	const scaled = Math.abs(value) * (section.includes("%") ? 100 : 1)
	const [whole = "0", fraction] = scaled.toFixed(decimals).split(".")
	const grouped = body.slice(0, dot < 0 ? body.length : dot).includes(",") ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole
	const sign = value < 0 && !negative ? "-" : ""

	return `${section.slice(0, first)}${sign}${grouped}${fraction === undefined ? "" : `.${fraction}`}${section.slice(last + 1)}`
}

// The result a text form field shows for `text` typed into it, as Word takes it: a number or date field takes
// only a number or a date (null otherwise), each shown with w:format, a regular field's w:format sets its case,
// and w:maxLength cuts it. Null for a field Word fills in itself.
export function legacyText(field: LegacyField, text: string): string | null {
	if (!typableField(field)) return null

	let out = text
	const format = field.format === "" ? null : field.format

	if (field.textType === "number" && text.trim() !== "") {
		const plain = text.trim().replace(/[\s,]/g, "")

		if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(plain)) return null

		out = format === null ? plain : formatNumber(Number(plain), format)
	} else if (field.textType === "date" && text.trim() !== "") {
		const iso = parseControlDate(text, format, null) ?? parseControlDate(text, DEFAULT_FIELD_DATE, null)

		if (iso === null) return null

		out = formatControlDate(iso, format ?? DEFAULT_FIELD_DATE, null)
	} else if (field.textType === "regular") {
		switch (format) {
			case "UPPERCASE":
				out = text.toLocaleUpperCase()
				break
			case "lowercase":
				out = text.toLocaleLowerCase()
				break
			case "First capital":
				out = text.charAt(0).toLocaleUpperCase() + text.slice(1)
				break
			case "Title case":
				out = text.replace(/(^|\s)(\p{L})/gu, (_match, space: string, letter: string) => space + letter.toLocaleUpperCase())
				break
		}
	}

	return field.maxLength > 0 ? firstCharacters(out, field.maxLength) : out
}

// What Word shows for an empty text form field: five en spaces (U+2002).
export const EMPTY_FORM_TEXT = "     "

// A picture swapped in a picture control (Word's Change Picture): a step replacing exactly the control's
// content, a picture, with one picture. `slice` is the step's inserted content.
export function pictureSwap(
	part: StoryPart,
	doc: Node,
	from: number,
	to: number,
	slice: { readonly childCount: number; readonly firstChild: Node | null }
): boolean {
	if (slice.childCount !== 1 || slice.firstChild?.type.name !== "drawing" || from === to) return false

	const around = inlineControlAround(part, doc, from, to)

	return (
		around !== undefined &&
		around.info.type === "picture" &&
		around.from === from &&
		around.to === to &&
		typeable(around.info) === "notText"
	)
}
