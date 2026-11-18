import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { InfoIcon } from "lucide-react"
import { codeLanguageIdFor, highlightCodeRuns, mountCodeHighlightStyle, type CodeRun } from "@filen/office/dom/code"
import type { CodeLanguageId } from "@filen/office/core/code"
import { codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { RenderedSourceViewer, type RenderedSource } from "@/features/preview/components/renderedSourceViewer"
import type { TextViewerProps } from "@/features/preview/components/textViewer"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { PreviewMarkdown } from "@/features/preview/components/previewMarkdown"
import { SafeHtmlDocument } from "@/features/preview/components/safeHtmlDocument"
import { sanitizeEmailHtml } from "@/features/preview/lib/emailSanitizer"
import { readNotebookFile } from "@/features/preview/lib/textFamilyClient"
import type { NotebookCell, NotebookOutput, NotebookReading } from "@/features/preview/lib/notebookReading"
import { deviceProfile } from "@/lib/deviceProfile"
import { workerDecodePixels } from "@/lib/pixelBudget"
import { useNearViewport } from "@/lib/useNearViewport"
import { log } from "@/lib/log"
import { cn } from "@filen/shared"

// A Jupyter notebook: an "In [n]:" gutter, code highlighted as the editor would, outputs under it (HTML in the
// script-less frame, mounted only near the viewport; images inline), markdown cells rendered as a markdown file is.

// The browser decodes an <img> to RGBA8, and holds no other copy.
const NOTEBOOK_IMAGE_BPP = 4
// Highlighted lines a document: past them cells stay plain monospace.
const HIGHLIGHT_MAX_LINES = 10_000
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

function Runs({ runs }: { runs: readonly CodeRun[] }) {
	return runs.map((run, index) =>
		run.classes === "" ? (
			run.text
		) : (
			<span
				key={index}
				className={run.classes}
			>
				{run.text}
			</span>
		)
	)
}

function Truncated() {
	const { t } = useTranslation("preview")

	return <p className="text-xs text-muted-foreground italic">{t("previewNotebookTruncated")}</p>
}

function CodeSource({ source, runs }: { source: string; runs: readonly CodeRun[] | null }) {
	return (
		<pre className="fo-code-static overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-[13px] leading-5 select-text">
			<code>{runs === null ? source : <Runs runs={runs} />}</code>
		</pre>
	)
}

// An HTML output: sanitized and framed only near the viewport; away from it, a placeholder of its last height.
function HtmlOutput({ html }: { html: string }) {
	const { t } = useTranslation("preview")
	const [element, setElement] = useState<HTMLDivElement | null>(null)
	const near = useNearViewport(element, HTML_MOUNT_MARGIN)
	const sanitized = near ? sanitizeEmailHtml(html, () => null) : null

	return (
		<div ref={setElement}>
			{sanitized === null ? (
				<div className="h-24" />
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
	runs,
	urls,
	alt
}: {
	cell: NotebookCell
	runs: readonly CodeRun[] | null
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
						runs={runs}
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

// Each code cell's runs, until HIGHLIGHT_MAX_LINES lines are highlighted; later cells stay plain.
function highlightedRuns(cells: readonly NotebookCell[], language: CodeLanguageId | null): (readonly CodeRun[] | null)[] {
	let lines = 0

	return cells.map(cell => {
		if (cell.kind !== "code" || language === null || lines >= HIGHLIGHT_MAX_LINES) return null

		lines += cell.source.split("\n").length

		return lines > HIGHLIGHT_MAX_LINES ? null : highlightCodeRuns(cell.source, language)
	})
}

function NotebookView({ text, fileBytes, alt }: { text: string; fileBytes: number; alt: string }) {
	const { t } = useTranslation("preview")
	const state = useNotebookReading(text, fileBytes)

	useEffect(() => {
		mountCodeHighlightStyle(document)
	}, [])

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
	const runs = highlightedRuns(reading.cells, language)

	return (
		<div
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
						runs={runs[index] ?? null}
						urls={state.urls}
						alt={alt}
					/>
				))}
			</div>
		</div>
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

// A Jupyter notebook (G1): its cells rendered, its JSON source a toggle away (editable as text).
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
