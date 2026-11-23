import { useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { MathFormula } from "@/features/preview/components/mathFormula"
import { MermaidFence } from "@/features/preview/components/mermaidDiagram"
import type { EmbedStore } from "@/features/preview/lib/livePreview/embedStore"

// The live preview's formulas and diagrams, each portalled into its widget's element: drawn by the Read view's own
// components, in the host's context (theme, translations, the diagram frame).
export function LivePreviewEmbeds({ store }: { store: EmbedStore }) {
	const embeds = useSyncExternalStore(store.subscribe, store.get, store.get)

	return embeds.map(embed =>
		createPortal(
			embed.kind === "math" ? (
				<MathFormula
					latex={embed.source}
					display={embed.display}
				/>
			) : (
				<MermaidFence
					source={embed.source}
					ordinal={0}
					uncounted
				/>
			),
			embed.dom,
			String(embed.id)
		)
	)
}
