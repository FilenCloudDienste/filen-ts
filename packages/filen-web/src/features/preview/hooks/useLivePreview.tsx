import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { Extension } from "@codemirror/state"
import { livePreview } from "@/features/preview/lib/livePreview/livePreview"
import type { LivePreviewConfig } from "@/features/preview/lib/livePreview/decorations"
import { EmbedStore } from "@/features/preview/lib/livePreview/embedStore"
import { markdownUrlTransform, previewImageSource } from "@/features/preview/components/markdownViewer.logic"
import { LivePreviewEmbeds } from "@/features/preview/components/livePreviewEmbeds"
import { MermaidScopeContext, type MermaidScope } from "@/features/preview/lib/mermaidScope"
import { useMermaidScope } from "@/features/preview/hooks/useMermaidDiagram"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

// A markdown editor's live preview (lib/livePreview), drawn under its host's Read view policy:
// - "preview" (a file): as PreviewMarkdown draws it, with formulas and Mermaid diagrams, and images only from data: URLs;
// - "plain" (a note): as the notes' MarkdownRenderer draws it, images where the link policy admits their URL.
// Links open on Mod+click through the link policy and the trust confirmation, as a click in the Read view does.
// Formulas and diagrams render in the editor's widgets through portals of this host's tree, so they keep its context
// (theme, translations, the diagram frame).

export type LivePreviewFlavor = "preview" | "plain"

const IS_MAC = isMacPlatform()

export interface LivePreviewHost {
	// For the editor (CodeMirrorSource's livePreview), the same value for the host's life but on a language change.
	readonly extension: Extension
	// Rendered by the host: the embeds' portals and the link confirmation.
	readonly node: ReactNode
	// The diagrams' scope (their frame), for the host's Read view to share: one frame a document.
	readonly mermaidScope: MermaidScope
}

export function useLivePreview(flavor: LivePreviewFlavor): LivePreviewHost {
	const { t, i18n } = useTranslation("preview")
	const gate = useTrustedLinkGate()
	const gateRef = useRef(gate)
	const [store] = useState(() => new EmbedStore())
	const scope = useMermaidScope()

	useEffect(() => {
		gateRef.current = gate
	})

	// Built once per language (the labels the decorations carry): a new one rebuilds every decoration.
	const build = (): Extension => {
		const preview = flavor === "preview"
		const config: LivePreviewConfig = {
			image: preview ? previewImageSource : url => markdownUrlTransform(url) ?? null,
			openLink: url => {
				const href = markdownUrlTransform(url)

				if (href !== undefined) {
					gateRef.current.requestOpen(href)
				}
			},
			labels: {
				imageNotLoaded: alt => t("previewMarkdownImageNotLoaded", { alt }),
				task: t("previewMarkdownTaskToggle"),
				openLink: t(IS_MAC ? "previewMarkdownOpenLinkMac" : "previewMarkdownOpenLink")
			},
			math: preview ? store.renderer("math") : null,
			mermaid: preview ? store.renderer("mermaid") : null
		}

		return livePreview(config)
	}

	const [built, setBuilt] = useState(() => ({ language: i18n.language, extension: build() }))

	if (built.language !== i18n.language) {
		setBuilt({ language: i18n.language, extension: build() })
	}

	return {
		extension: built.extension,
		mermaidScope: scope,
		node: (
			<MermaidScopeContext value={scope}>
				<LivePreviewEmbeds store={store} />
				{gate.dialog}
			</MermaidScopeContext>
		)
	}
}
