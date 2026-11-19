import { joinBytes } from "../../../opc/index"
import { NodeKind, Namespaces, parseXml, type XmlDocument } from "../../../xml/index"
import { BindingStores } from "../../forms/binding"
import { CHECKED_GLYPH, UNCHECKED_GLYPH } from "../../forms/controls"
import type { StoryPart } from "../../model/index"
import { Ns } from "../../model/namespaces"
import { partReader, type PartReader } from "../../model/reader"
import { DocxVerifyError } from "../failure"
import { changedStores, updatedNode } from "../parts/customXml"
import type { CheckedPart, CheckInput, DocxCheck } from "./index"

// Content controls as written: a checkbox shows the glyph of its state (MS-DOCX §2.6.1.2: w14:checkedState and
// w14:uncheckedState, Word's defaults U+2612 and U+2610), a drop-down list's w:lastValue is one of its entries,
// a date's w:fullDate is an xsd:dateTime (ECMA-376 Part 1 §17.5.2.7), and a bound control whose value changed
// has its node in the store hold that value (§17.5.2.6), so Word does not put the old value back on open.

function fail(message: string): never {
	throw new DocxVerifyError("content", message)
}

const DATE_TIME = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/

// The text of a control's content as written: w:t outside deletions (copies written as source bytes do not
// show in a skeleton and count as nothing).
function contentText(reader: PartReader, content: number): string {
	const document = reader.document
	const end = document.end(content)
	let out = ""

	for (let node = content + 1; node < document.count && document.start(node) < end; node++) {
		if (document.kinds[node] === NodeKind.Element && reader.is(node, Ns.W, "t")) out += reader.text(node)
	}

	return out
}

function glyph(reader: PartReader, checkbox: number, local: string, fallback: number): string {
	const node = reader.child(checkbox, Ns.W14, local)
	const value = node < 0 ? undefined : reader.attr(node, Ns.W14, "val")
	const code = value === undefined ? fallback : Number.parseInt(value, 16)

	return String.fromCodePoint(Number.isInteger(code) && code > 0 && code <= 0x10ffff ? code : fallback)
}

function checkControl(name: string, reader: PartReader, sdt: number): void {
	const sdtPr = reader.child(sdt, Ns.W, "sdtPr")
	const content = reader.child(sdt, Ns.W, "sdtContent")

	if (sdtPr < 0) return

	const checkbox = reader.child(sdtPr, Ns.W14, "checkbox")

	if (checkbox >= 0 && content >= 0) {
		const checkedNode = reader.child(checkbox, Ns.W14, "checked")
		const value = checkedNode < 0 ? undefined : reader.attr(checkedNode, Ns.W14, "val")
		const checked = checkedNode >= 0 && value !== "0" && value !== "false" && value !== "off"
		const on = glyph(reader, checkbox, "checkedState", CHECKED_GLYPH)
		const off = glyph(reader, checkbox, "uncheckedState", UNCHECKED_GLYPH)
		const text = contentText(reader, content)
		const wanted = checked ? on : off
		const other = checked ? off : on

		if (on !== off && text.includes(other) && !text.includes(wanted)) fail(`${name}: a checkbox shows the glyph of the other state`)
	}

	const list = reader.child(sdtPr, Ns.W, "dropDownList")

	if (list >= 0) {
		const last = reader.attr(list, Ns.W, "lastValue")
		const document = reader.document
		let found = last === undefined

		for (let item = document.firstChildElement(list); item >= 0 && !found; item = document.nextSiblingElement(item)) {
			if (reader.is(item, Ns.W, "listItem") && reader.attr(item, Ns.W, "value") === last) found = true
		}

		if (!found) fail(`${name}: a drop-down list's last value is none of its entries`)
	}

	const date = reader.child(sdtPr, Ns.W, "date")
	const fullDate = date < 0 ? undefined : reader.attr(date, Ns.W, "fullDate")

	if (fullDate !== undefined && !DATE_TIME.test(fullDate)) fail(`${name}: a date control's date is not a date and time`)
}

// Controls (by w:id) of a source part that fail the checks as the source has them: kept as they are.
const sourceFailures = new WeakMap<StoryPart, ReadonlySet<string>>()

function failingInSource(part: StoryPart): ReadonlySet<string> {
	let found = sourceFailures.get(part)

	if (found === undefined) {
		const out = new Set<string>()
		const reader = part.reader

		for (let row = 0; row < part.sdts.count; row++) {
			const sdt = part.node(part.sdts.item[row] ?? -1)

			try {
				checkControl(part.name, reader, sdt)
			} catch {
				out.add(controlId(reader, sdt) ?? "")
			}
		}

		found = out
		sourceFailures.set(part, found)
	}

	return found
}

function controlId(reader: PartReader, sdt: number): string | undefined {
	const sdtPr = reader.child(sdt, Ns.W, "sdtPr")
	const id = sdtPr < 0 ? -1 : reader.child(sdtPr, Ns.W, "id")

	return id < 0 ? undefined : reader.attr(id, Ns.W, "val")
}

// How many controls of a source part's bytes carry each w:id.
const sourceIds = new WeakMap<StoryPart, ReadonlyMap<string, number>>()

function idsInSource(part: StoryPart): ReadonlyMap<string, number> {
	let found = sourceIds.get(part)

	if (found === undefined) {
		const out = new Map<string, number>()
		const document = part.document
		const reader = part.reader

		// Every w:sdt of the bytes (a text box's fallback repeats its controls).
		for (let node = 0; node < document.count; node++) {
			if (document.kinds[node] !== NodeKind.Element || !reader.is(node, Ns.W, "sdt")) continue

			const id = controlId(reader, node)

			if (id !== undefined) out.set(id, (out.get(id) ?? 0) + 1)
		}

		found = out
		sourceIds.set(part, found)
	}

	return found
}

// A control's w:id is unique within its part (ECMA-376 Part 1 §17.5.2.18): a copy carries an id of its own; ids
// the source already repeats stay as they were. A text box's mc:Fallback (its VML) repeats the mc:Choice's
// controls with their ids, as Word writes it: those are not counted.
const controls: DocxCheck = {
	part(_input: CheckInput, part: CheckedPart) {
		if (part.part === undefined) return

		const document = part.document
		const reader = partReader(document)
		const ids = new Map<string, number>()
		let kept: ReadonlySet<string> | undefined
		let fallbackEnd = -1

		for (let node = 0; node < document.count; node++) {
			if (document.kinds[node] !== NodeKind.Element) continue
			if (fallbackEnd >= 0 && document.start(node) >= fallbackEnd) fallbackEnd = -1

			if (fallbackEnd < 0 && reader.group(node) === Ns.MC && document.localName(node) === "Fallback") {
				fallbackEnd = document.end(node)

				continue
			}

			if (!reader.is(node, Ns.W, "sdt")) continue

			const id = fallbackEnd >= 0 ? undefined : controlId(reader, node)

			if (id !== undefined) {
				const count = (ids.get(id) ?? 0) + 1

				ids.set(id, count)

				if (count > 1 && count > (idsInSource(part.part).get(id) ?? 0))
					fail(`${part.name}: content control id ${id} appears ${String(count)} times`)
			}

			try {
				checkControl(part.name, reader, node)
			} catch (error) {
				kept ??= failingInSource(part.part)

				if (!kept.has(controlId(reader, node) ?? "")) throw error
			}
		}
	}
}

async function writtenXml(input: CheckInput, name: string): Promise<XmlDocument> {
	const change = input.changes.replace.find(entry => entry.name === name)

	return change === undefined ? input.original.xml(name) : parseXml(await joinBytes(change.bytes))
}

const bindings: DocxCheck = {
	async done(input: CheckInput) {
		const changed = changedStores({
			sessions: input.changes.stories.map(story => story.session),
			docs: input.changes.stories.map(story => story.doc)
		})

		if (changed.size === 0) return

		const stores = new BindingStores(input.original)

		for (const [store, values] of changed) {
			const name = await stores.part(store)

			if (name === undefined) continue

			const document = await writtenXml(input, name)
			const namespaces = new Namespaces(document, { lenient: true })
			const reader = partReader(document)

			for (const control of values.values()) {
				const node = updatedNode(document, namespaces, control)

				if (node >= 0 && reader.text(node) !== control.value) fail(`${name}: a bound content control's node lost its new value`)
			}
		}
	}
}

export const formChecks: readonly DocxCheck[] = [controls, bindings]
