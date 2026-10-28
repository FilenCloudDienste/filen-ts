import { convertPresentation, type Converted } from "../core/convert/presentation/index"
import type { ByteSink, Slicing } from "../core/opc/index"
import type { PptConversion } from "../core/ppt/toPptx"
import { openPptxPackage } from "../core/pptx/package"
import type { Refused } from "../core/presentation/model"
import { passwordSeal } from "../dom/presentation/engine/convert"

// A PowerPoint 97–2003 deck converted to .pptx as the presentation worker's Download as writes it: the package the
// deck opened as, through convertPresentation, sealed under the open password when the deck had one.
export async function pptAsPptx(
	converted: PptConversion,
	sink: ByteSink,
	options: { readonly password?: string; readonly slicing?: Slicing } = {}
): Promise<Converted | Refused> {
	const opened = await openPptxPackage(converted.pptx, converted.encrypted ? { encrypted: { scheme: "rc4CryptoApi" } } : {})

	if (opened.kind === "refused") return opened

	opened.deck.format = "ppt"

	return convertPresentation(
		opened.deck,
		{ format: "ppt", parts: opened.parts, pptx: converted.pptx, losses: () => converted.losses },
		"pptx",
		sink,
		{
			...(options.slicing === undefined ? {} : { slicing: options.slicing }),
			...(options.password === undefined ? {} : { seal: passwordSeal(options.password, options.slicing) })
		}
	)
}
