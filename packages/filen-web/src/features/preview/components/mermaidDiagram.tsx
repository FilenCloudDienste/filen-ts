import { useContext, useEffect, useId, useRef, useState } from "react"
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

// A diagram's height before it is drawn, guessed from its source (a line a row of boxes, roughly), so the drawing
// replaces a placeholder of about its size rather than pushing the text below it.
function placeholderHeight(source: string): number {
	const lines = source.split("\n", 64).length

	return Math.min(480, Math.max(96, lines * 28))
}

// "Rendering diagram…" in the diagram's place: while the frame starts (the first diagram of a page waits for it), then
// while it draws, then until the picture has loaded.
function Rendering({ source }: { source: string }) {
	const { t } = useTranslation("preview")

	return (
		<div
			role="status"
			className="mb-3 flex items-center justify-center rounded-lg bg-muted text-sm text-muted-foreground"
			style={{ minHeight: placeholderHeight(source) }}
		>
			{t("previewMermaidRendering")}
		</div>
	)
}

function InlineSvg({ svg, source }: { svg: Blob; source: string }) {
	const { t } = useTranslation("preview")
	const url = useObjectUrl(svg)
	const [loaded, setLoaded] = useState(false)

	return (
		<div className="relative">
			{loaded ? null : <Rendering source={source} />}
			{url === null ? null : (
				<img
					src={url}
					alt={t("previewMermaidAlt")}
					draggable={false}
					onLoad={() => {
						setLoaded(true)
					}}
					// Laid out only once loaded: until then the placeholder holds its place.
					className={loaded ? "mb-3 h-auto max-w-full" : "pointer-events-none absolute top-0 left-0 h-auto max-w-full opacity-0"}
				/>
			)}
		</div>
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
			return <Rendering source={source} />
	}
}

// A markdown fence, the document's `ordinal`th diagram (its scope counts across a notebook's cells). Without a scope (no
// diagram host above) it stays its source.
export function MermaidFence({ source, ordinal: ownOrdinal }: { source: string; ordinal: number }) {
	const { t } = useTranslation("preview")
	const scope = useContext(MermaidScopeContext)
	const [near, setNear] = useState(false)
	const [asked, setAsked] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	const key = useId()
	const ordinal = scope === null ? ownOrdinal : scope.ordinalFor(key)
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
				<InlineSvg
					svg={state.svg}
					source={source}
				/>
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
