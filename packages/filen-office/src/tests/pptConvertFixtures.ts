import { convertPresentation, type Converted } from "../core/convert/presentation/index"
import { CfbFile } from "../core/cfb/index"
import { bytesSource, type ByteSink, type Slicing } from "../core/opc/index"
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

// The compound file's top-level streams by name, copied out.
export async function streams(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
	const cfb = await CfbFile.open(bytesSource(bytes))
	const out = new Map<string, Uint8Array>()

	for (const entry of cfb.walk())
		if (entry.kind === "stream" && entry.path.length === 1) out.set(entry.name, (await cfb.read(entry)).slice())

	return out
}

// A sink that keeps nothing.
export const nullSink = (): ByteSink => ({ write: () => Promise.resolve(), close: () => Promise.resolve() })

// A sink that keeps only the count of bytes written.
export function countingSink(): ByteSink & { readonly size: () => number } {
	let size = 0

	return {
		write(chunk) {
			size += chunk.length

			return Promise.resolve()
		},
		close: () => Promise.resolve(),
		size: () => size
	}
}
