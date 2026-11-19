import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { InfoIcon } from "lucide-react"
import { codeLanguageIdFor } from "@filen/office/dom/code"
import type { CodeLanguageId } from "@filen/office/core/code"
import { codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { RenderedSourceViewer, type RenderedSource } from "@/features/preview/components/renderedSourceViewer"
import type { TextViewerProps } from "@/features/preview/components/textViewer"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { PreviewMarkdown } from "@/features/preview/components/previewMarkdown"
import { HighlightedFence } from "@/features/preview/components/highlightedFence"
import { FenceBudgetContext, newFenceBudget, type FenceBudget } from "@/features/preview/lib/fenceBudget"
import { useMermaidScope } from "@/features/preview/hooks/useMermaidDiagram"
import { MermaidScopeContext } from "@/features/preview/lib/mermaidScope"
import { SafeHtmlDocument } from "@/features/preview/components/safeHtmlDocument"
import { sanitizeEmailHtml } from "@/features/preview/lib/emailSanitizer"
import { readNotebookFile } from "@/features/preview/lib/textFamilyClient"
import type { NotebookCell, NotebookOutput, NotebookReading } from "@/features/preview/lib/notebookReading"
import { deviceProfile } from "@/lib/deviceProfile"
import { workerDecodePixels } from "@/lib/pixelBudget"
import { NearViewportRootContext, useNearViewport } from "@/lib/useNearViewport"
import { log } from "@/lib/log"
import { cn } from "@filen/shared"

// A Jupyter notebook: an "In [n]:" gutter, code highlighted as the editor would, outputs under it (HTML in the
// script-less frame, mounted only near the notebook's scroll position; images inline), markdown cells rendered as a markdown file is.

// The browser decodes an <img> to RGBA8, and holds no other copy.
const NOTEBOOK_IMAGE_BPP = 4
// How near the viewport an HTML output mounts.
const HTML_MOUNT_MARGIN = 1200

type ReadingState =
	{ status: "pending" } | { status: "done"; reading: NotebookReading; urls: ReadonlyMap<Blob, string> } | { status: "failed" }

// The read, with an object URL for each image, revoked when the notebook goes.
function useNotebookReading(text: string, fileBytes: number): ReadingState {
	const [state, setState] = useState<ReadingState>({ status: "pending" })

	useEffect(() => {
		let live = true
		let urls: ReadonlyMap<Blob, string> = new Map()

		readNotebookFile(text, workerDecodePixels(deviceProfile(), fileBytes, NOTEBOOK_IMAGE_BPP)).then(
			reading => {
				if (!live) return

				const made = new Map<Blob, string>()

				if (reading.status === "ok") {
					for (const cell of reading.cells) {
						if (cell.kind !== "code") continue

						for (const output of cell.outputs) {
							if (output.kind === "image") made.set(output.blob, URL.createObjectURL(output.blob))
						}
					}
				}

				urls = made
				setState({ status: "done", reading, urls })
			},
			(e: unknown) => {
				if (!live) return

				log.error("preview", "reading a notebook failed", e)
				setState({ status: "failed" })
			}
		)

		return () => {
			live = false

			for (const url of urls.values()) URL.revokeObjectURL(url)
		}
	}, [text, fileBytes])

	return state
}

function Truncated() {
	const { t } = useTranslation("preview")

	return <p className="text-xs text-muted-foreground italic">{t("previewNotebookTruncated")}</p>
}

// A code cell's source, highlighted near the viewport on idle within the notebook's budget (as a markdown file's fences).
function CodeSource({ source, language }: { source: string; language: CodeLanguageId | null }) {
	return (
		<pre className="overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-[13px] leading-5 select-text">
			{language === null ? (
				<code>{source}</code>
			) : (
				<HighlightedFence
					language={language}
					text={source}
					className=""
				/>
			)}
		</pre>
	)
}

type SanitizedHtml = ReturnType<typeof sanitizeEmailHtml>

// An HTML output: sanitized once (when it first comes near its scroller) and framed only near it; away from it, a
// placeholder of its last measured height, so leaving and returning moves neither the reading position nor the sanitizer.
function HtmlOutput({ html }: { html: string }) {
	const { t } = useTranslation("preview")
	const [element, setElement] = useState<HTMLDivElement | null>(null)
	const [content, setContent] = useState<HTMLDivElement | null>(null)
	const near = useNearViewport(element, HTML_MOUNT_MARGIN)
	const [cached, setCached] = useState<{ html: string; sanitized: SanitizedHtml } | null>(null)
	const [height, setHeight] = useState<number | null>(null)
	const sanitized = cached !== null && cached.html === html ? cached.sanitized : null

	if (near && sanitized === null) {
		setCached({ html, sanitized: sanitizeEmailHtml(html, () => null) })
	}

	// The content's own height (the wrapper's floor below never feeds back into it), skipped while a mounted frame has
	// not sized itself yet: a remounted frame starts at the default iframe height until its document loads and measures.
	useEffect(() => {
		if (content === null || typeof ResizeObserver === "undefined") {
			return undefined
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries.at(-1)
			const frame = content.querySelector("iframe")

			if (entry !== undefined && entry.contentRect.height > 0 && frame?.style.height !== "") {
				setHeight(entry.contentRect.height)
			}
		})

		observer.observe(content)

		return () => {
			observer.disconnect()
		}
	}, [content])

	return (
		<div
			ref={setElement}
			style={height === null ? undefined : { minHeight: height }}
		>
			<div ref={setContent}>
				{!near || sanitized === null ? (
					height === null ? (
						<div className="h-24" />
					) : (
						<div style={{ height }} />
					)
				) : sanitized.tooLarge ? (
					<p className="text-sm text-muted-foreground">{t("previewNotebookOutputTooLarge")}</p>
				) : (
					<SafeHtmlDocument
						html={sanitized.html}
						links={sanitized.links}
						title={t("previewNotebookHtmlOutput")}
						layout="autoHeight"
						paper
					/>
				)}
			</div>
		</div>
	)
}

function Output({ output, urls }: { output: NotebookOutput; urls: ReadonlyMap<Blob, string> }) {
	const { t } = useTranslation("preview")

	switch (output.kind) {
		case "stream":
		case "text":
			return (
				<>
					<pre
						className={cn(
							"overflow-x-auto font-mono text-[13px] leading-5 whitespace-pre-wrap select-text",
							output.kind === "stream" && output.error ? "rounded-md bg-destructive/10 px-3 py-2" : null
						)}
					>
						{output.text}
					</pre>
					{output.truncated ? <Truncated /> : null}
				</>
			)
		case "error":
			return (
				<>
					<pre className="overflow-x-auto rounded-md bg-destructive/10 px-3 py-2 font-mono text-[13px] leading-5 whitespace-pre-wrap select-text">
						{output.traceback === "" ? `${output.name}: ${output.value}` : output.traceback}
					</pre>
					{output.truncated ? <Truncated /> : null}
				</>
			)
		case "markdown":
			return (
				<div className="[&>div]:h-auto [&>div]:overflow-visible [&>div]:p-0">
					<PreviewMarkdown
						text={output.text}
						alt={t("previewNotebookRendered")}
					/>
				</div>
			)
		case "html":
			return <HtmlOutput html={output.html} />
		case "image":
			return (
				<img
					src={urls.get(output.blob)}
					width={output.width}
					height={output.height}
					alt=""
					loading="lazy"
					decoding="async"
					className="h-auto max-w-full"
				/>
			)
		case "svg":
			return (
				<img
					src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(output.svg)}`}
					alt=""
					loading="lazy"
					decoding="async"
					className="h-auto max-w-full"
				/>
			)
		case "tooLarge":
			return <p className="text-sm text-muted-foreground">{t("previewNotebookOutputTooLarge")}</p>
	}
}

function Cell({
	cell,
	language,
	urls,
	alt
}: {
	cell: NotebookCell
	language: CodeLanguageId | null
	urls: ReadonlyMap<Blob, string>
	alt: string
}) {
	const { t } = useTranslation("preview")

	return (
		<section className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 py-2 [contain-intrinsic-size:auto_6rem] [content-visibility:auto]">
			<div className="pt-2 text-right font-mono text-xs text-muted-foreground tabular-nums">
				{cell.kind === "code"
					? cell.executionCount === null
						? t("previewNotebookInNotRun")
						: t("previewNotebookIn", { count: cell.executionCount })
					: null}
			</div>
			<div className="flex min-w-0 flex-col gap-2">
				{cell.kind === "markdown" ? (
					<div className="[&>div]:h-auto [&>div]:overflow-visible [&>div]:p-0">
						<PreviewMarkdown
							text={cell.source}
							alt={alt}
						/>
					</div>
				) : cell.kind === "raw" ? (
					<pre className="overflow-x-auto font-mono text-[13px] leading-5 whitespace-pre-wrap select-text">{cell.source}</pre>
				) : (
					<CodeSource
						source={cell.source}
						language={language}
					/>
				)}
				{cell.truncated ? <Truncated /> : null}
				{cell.kind === "code"
					? cell.outputs.map((output, index) => (
							<Output
								key={index}
								output={output}
								urls={urls}
							/>
						))
					: null}
				{cell.kind === "code" && cell.outputsOmitted > 0 ? (
					<p className="text-xs text-muted-foreground">{t("previewNotebookOutputsOmitted", { count: cell.outputsOmitted })}</p>
				) : null}
			</div>
		</section>
	)
}

function NotebookView({ text, fileBytes, alt }: { text: string; fileBytes: number; alt: string }) {
	const { t } = useTranslation("preview")
	const state = useNotebookReading(text, fileBytes)
	// One highlighting budget, one diagram frame and one count of diagrams for the whole notebook, its markdown cells
	// and outputs included.
	const [budget] = useState<FenceBudget>(newFenceBudget)
	const scope = useMermaidScope()
	// The scroller the outputs and fences measure their nearness against.
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null)

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	if (state.status === "failed") {
		return <PreviewErrorState message={t("previewNotebookFailed")} />
	}

	const reading = state.reading

	if (reading.status !== "ok") {
		return <PreviewErrorState message={t(reading.status === "tooLarge" ? "previewNotebookTooLarge" : "previewNotebookInvalid")} />
	}

	const language = codeLanguageIdFor(reading.language ?? "") ?? codeLanguageIdFor(reading.extension ?? "")

	return (
		<MermaidScopeContext value={scope}>
			<FenceBudgetContext value={budget}>
				<NearViewportRootContext value={scroller}>
					<div
						ref={setScroller}
						role="document"
						aria-label={alt}
						className="size-full overflow-auto px-4 py-4 select-text"
					>
						<div className="mx-auto flex max-w-5xl flex-col">
							{reading.cellsSkipped > 0 ? (
								<p className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
									<InfoIcon className="size-3.5 shrink-0" />
									{t("previewNotebookCellsSkipped", { count: reading.cellsSkipped })}
								</p>
							) : null}
							{reading.cells.map((cell, index) => (
								<Cell
									key={index}
									cell={cell}
									language={language}
									urls={state.urls}
									alt={alt}
								/>
							))}
						</div>
					</div>
				</NearViewportRootContext>
			</FenceBudgetContext>
		</MermaidScopeContext>
	)
}

function renderNotebook(source: RenderedSource, alt: string) {
	return (
		<NotebookView
			text={source.file.text}
			fileBytes={source.bytes.length}
			alt={alt}
		/>
	)
}

// A Jupyter notebook: its cells rendered, its JSON source a toggle away (editable as text).
export function NotebookViewer({ item, alt, editable, onDirtyChange, contentRef, locked, onTextState, readAs }: TextViewerProps) {
	const { t } = useTranslation("preview")

	return (
		<RenderedSourceViewer
			item={item}
			alt={alt}
			renderer={source => renderNotebook(source, alt)}
			tag={codeMirrorLanguageFor(itemTypeExtension(item))}
			formatting={false}
			labels={{ view: t("previewNotebookView"), rendered: t("previewNotebookRendered") }}
			{...(editable === undefined ? {} : { editable })}
			{...(onDirtyChange === undefined ? {} : { onDirtyChange })}
			{...(contentRef === undefined ? {} : { contentRef })}
			{...(locked === undefined ? {} : { locked })}
			{...(onTextState === undefined ? {} : { onTextState })}
			{...(readAs === undefined ? {} : { readAs })}
		/>
	)
}
