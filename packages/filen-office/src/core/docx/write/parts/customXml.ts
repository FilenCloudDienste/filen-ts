import { Namespaces, XmlEditor, type XmlDocument } from "../../../xml/index"
import { partReader } from "../../model/reader"
import { BindingStores, CORE_PROPERTIES_STORE, boundNode, changedBindings, editedValue, type BoundControl } from "../../forms/binding"
import { holdsBindings } from "../../forms/positions"
import { coreEdit } from "./core"
import type { PartContributor, SaveParts, WrittenStories } from "./index"

// The data bound content controls show (ECMA-376 Part 1 §17.5.2.6): Word replaces a bound control's content
// with its node's text on open, so a control whose value changed has its node updated (a custom XML item, or
// the core or extended properties part). Only controls whose value differs from the story as built are
// written. The editor keeps the controls of a node alike; where they still disagree (a value one of them cannot
// show), the node takes the value the latest edit gave it (else the first changed control's), never staying
// stale. A binding whose store or node does not exist binds nothing (§17.5.2.6), and Word maps a control only to
// a node without child elements (Microsoft Learn, "Content controls in Word": "it can only successfully map to
// leaf nodes or attributes"): there is nothing to update.

// Changed bound controls of every written story, by store item and bound node.
export function changedStores(written: Omit<WrittenStories, "stories">): Map<string, Map<string, BoundControl>> {
	const out = new Map<string, Map<string, BoundControl>>()
	const values = new Map<string, BoundControl[]>()

	written.sessions.forEach((session, k) => {
		// A story holding no bound control has nothing to compare (a walk of a long one is long).
		if (!holdsBindings(session)) return

		const doc = written.docs[k] ?? session.state.doc

		for (const [key, controls] of changedBindings(session.story.part, session.story.doc, doc))
			values.set(key, [...(values.get(key) ?? []), ...controls])
	})

	const context = written.sessions[0]?.context

	for (const [key, controls] of values) {
		const first = controls[0]

		if (first === undefined) continue

		const latest = context === undefined ? undefined : editedValue(context, key)
		const chosen = controls.find(control => control.value === latest) ?? first
		let store = out.get(chosen.binding.store)

		if (store === undefined) {
			store = new Map()
			out.set(chosen.binding.store, store)
		}

		store.set(key, chosen)
	}

	return out
}

// The bound node a control updates in `document`, or -1 (none, or one with child elements).
export function updatedNode(document: XmlDocument, namespaces: Namespaces, control: BoundControl): number {
	const node = boundNode(document, namespaces, control.binding)

	return node >= 0 && document.firstChildElement(node) < 0 ? node : -1
}

async function contribute(parts: SaveParts, written: WrittenStories): Promise<void> {
	const changed = changedStores(written)

	if (changed.size === 0) return

	const stores = new BindingStores(parts.pkg)

	for (const [store, controls] of changed) {
		const name = await stores.part(store)

		if (name === undefined) continue

		// The core part is written once, by its own contributor (core.ts).
		const core = store === CORE_PROPERTIES_STORE ? await coreEdit(parts) : undefined
		const document = core?.editor.document ?? (await parts.xml(name))

		if (document === undefined) continue

		const namespaces = new Namespaces(document, { lenient: true })
		const reader = partReader(document)
		const editor = core?.editor ?? new XmlEditor(document)

		for (const control of controls.values()) {
			const node = updatedNode(document, namespaces, control)

			if (node >= 0 && reader.text(node) !== control.value) editor.setText(node, control.value)
		}

		if (core === undefined && editor.changed) parts.replace(name, editor.serialize())
	}
}

export const customXmlParts: PartContributor = { contribute }
