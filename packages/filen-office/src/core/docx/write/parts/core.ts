import { corePropertiesPart, stampCoreProperties } from "../../../opc/coreProperties"
import { XmlEditor } from "../../../xml/index"
import type { PartContributor, SaveParts } from "./index"

// docProps/core.xml (ECMA-376 Part 2 §11): Word sets Last Modified, Last Modified By and the revision count on
// every save that changes the document. Content controls bound to the core properties edit the same part (customXml.ts), through the one
// editor this contributor writes after them; a package without the part, or with one that does not parse,
// gets none.

export interface CoreEdit {
	readonly name: string
	readonly editor: XmlEditor
}

const KEY = {}

// The save's editor of the core properties part, shared by the contributors that edit it.
export function coreEdit(parts: SaveParts): Promise<CoreEdit | undefined> {
	return parts.state(KEY, async () => {
		const name = await corePropertiesPart(parts.pkg.opc)

		if (name === undefined) return undefined

		try {
			const document = await parts.xml(name)

			return document === undefined ? undefined : { name, editor: new XmlEditor(document) }
		} catch {
			// A malformed core part is left as it is.
			return undefined
		}
	})
}

async function contribute(parts: SaveParts): Promise<void> {
	// A save that writes nothing else leaves the file as it was.
	if (!parts.changed()) return

	const edit = await coreEdit(parts)

	if (edit === undefined) return

	const { identity, model } = parts.context

	stampCoreProperties(edit.editor, {
		modified: identity.now(),
		lastModifiedBy: model.settings.removePersonalInformation ? undefined : identity.author
	})

	if (edit.editor.changed) parts.replace(edit.name, edit.editor.serialize())
}

export const coreParts: PartContributor = { contribute }
