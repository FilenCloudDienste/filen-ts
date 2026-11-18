import { useContext, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MarkdownPre } from "@/features/preview/components/markdownRenderer"
import { BlobImage } from "@/features/preview/components/zoomableImage"
import { useMermaidDiagram, useMermaidScope, type MermaidDiagramState } from "@/features/preview/hooks/useMermaidDiagram"
import { MERMAID_AUTO_RENDER_LIMIT, MermaidScopeContext } from "@/features/preview/lib/mermaidScope"
import { useObjectUrl } from "@/lib/useObjectUrl"

// Mermaid diagrams as the preview shows them: a markdown file's fences (drawn when they come near, the first 50 of a
// document on their own and the rest on request) and a .mmd file's one diagram, zoomable.

function SourceBlock({ source, title }: { source: string; title?: string | undefined }) {
	return (
		<MarkdownPre>
			<code title={title}>{source}</code>
		</MarkdownPre>
	)
}

function RefusedDiagram({ source }: { source: string }) {
	const { t } = useTranslation("preview")
	const [shown, setShown] = useState(false)

	return (
		<div className="mb-3 flex flex-col items-start gap-2 rounded-lg border border-border p-3 text-sm text-muted-foreground">
			<p>{t("previewMermaidRefused")}</p>
			{shown ? (
				<div className="w-full">
					<SourceBlock source={source} />
				</div>
			) : (
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setShown(true)
					}}
				>
					{t("previewMermaidShowSource")}
				</Button>
			)}
		</div>
	)
}

function InlineSvg({ svg }: { svg: Blob }) {
	const { t } = useTranslation("preview")
	const url = useObjectUrl(svg)

	return url === null ? null : (
		<img
			src={url}
			alt={t("previewMermaidAlt")}
			draggable={false}
			className="mb-3 h-auto max-w-full"
		/>
	)
}

// Every state but a drawn diagram, alike for a fence and a file.
function DiagramState({ state, source }: { state: Exclude<MermaidDiagramState, { status: "svg" }>; source: string }) {
	const { t } = useTranslation("preview")

	switch (state.status) {
		case "refused":
			return <RefusedDiagram source={source} />
		case "tooComplex":
			return <p className="mb-3 rounded-lg border border-border p-3 text-sm text-muted-foreground">{t("previewMermaidTooComplex")}</p>
		case "failed":
			return (
				<SourceBlock
					source={source}
					title={t("previewMermaidUnreadable")}
				/>
			)
		case "waiting":
		case "pending":
			return (
				<div
					role="status"
					aria-label={t("previewMermaidRendering")}
					className="mb-3 h-24 rounded-lg bg-muted"
				/>
			)
	}
}

// A markdown fence, the document's `ordinal`th diagram. Without a scope (no diagram host above) it stays its source.
export function MermaidFence({ source, ordinal }: { source: string; ordinal: number }) {
	const { t } = useTranslation("preview")
	const scope = useContext(MermaidScopeContext)
	const [near, setNear] = useState(false)
	const [asked, setAsked] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	const automatic = ordinal < MERMAID_AUTO_RENDER_LIMIT

	useEffect(() => {
		const element = ref.current

		if (scope === null || element === null || !automatic) {
			return
		}

		return scope.whenNear(element, () => {
			setNear(true)
		})
	}, [scope, automatic])

	const state = useMermaidDiagram(scope, source, automatic ? near : asked)

	if (scope === null) {
		return <SourceBlock source={source} />
	}

	if (!automatic && !asked && state.status === "waiting") {
		return (
			<div className="mb-3 flex items-center gap-3 rounded-lg border border-border p-3">
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setAsked(true)
					}}
				>
					{t("previewMermaidRender")}
				</Button>
			</div>
		)
	}

	return (
		<div ref={ref}>
			{state.status === "svg" ? (
				<InlineSvg svg={state.svg} />
			) : (
				<DiagramState
					state={state}
					source={source}
				/>
			)}
		</div>
	)
}

// A .mmd/.mermaid file's diagram, drawn at once in the zoomable picture surface.
export function MermaidFileDiagram({ source }: { source: string }) {
	const { t } = useTranslation("preview")
	const scope = useMermaidScope()
	const state = useMermaidDiagram(scope, source, true)

	if (state.status === "svg") {
		return (
			<BlobImage
				blob={state.svg}
				alt={t("previewMermaidAlt")}
			/>
		)
	}

	return (
		<div className="size-full overflow-auto px-6 py-4">
			<DiagramState
				state={state}
				source={source}
			/>
		</div>
	)
}
