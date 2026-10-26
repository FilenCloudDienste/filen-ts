import type { XmlDocument } from "../../xml/index"
import type { ObjectDefault, ObjectDefaults } from "../../presentation/model"
import { readBodyPr, readListStyle, type ReadContext } from "./drawing"
import { G } from "./xml"

// The text half of a theme's a:objectDefaults (ECMA-376 Part 1 §20.1.6.7): a:spDef for shapes and a:txDef for text
// boxes, each its a:bodyPr and a:lstStyle as written. Shape insertion consumes them: they format a shape when it is
// inserted (§20.1.4.1.27–28). Stored shapes never resolve through them (core/presentation/inherit.ts explains why).
// a:lnDef is not read: a connector has no text body.
export function readObjectDefaults(context: ReadContext, document: XmlDocument): ObjectDefaults | undefined {
	const r = context.reader
	const holder = r.child(document.documentElement(), G.A, "objectDefaults")

	if (holder < 0) return undefined

	const read = (local: string): ObjectDefault | undefined => {
		const node = r.child(holder, G.A, local)

		if (node < 0) return undefined

		const bodyPr = readBodyPr(r, r.child(node, G.A, "bodyPr"))
		const lstStyle = r.child(node, G.A, "lstStyle")

		return { bodyPr, ...(lstStyle < 0 ? {} : { lstStyle: readListStyle(context, lstStyle) }) }
	}

	const sp = read("spDef")
	const tx = read("txDef")

	return sp === undefined && tx === undefined ? undefined : { ...(sp === undefined ? {} : { sp }), ...(tx === undefined ? {} : { tx }) }
}
