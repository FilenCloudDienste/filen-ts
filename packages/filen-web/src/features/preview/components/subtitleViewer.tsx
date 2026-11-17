import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { asDirectoryOrFile } from "@/features/drive/lib/item"
import { SUBTITLE_TABLE_MAX_BYTES, codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { RenderedSourceViewer, type RenderedSource } from "@/features/preview/components/renderedSourceViewer"
import { TextViewer, type TextViewerProps } from "@/features/preview/components/textViewer"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { readSubtitleCues } from "@/features/preview/lib/textFamilyClient"
import {
	cuesSpan,
	formatCueSpan,
	formatCueTime,
	matchingCues,
	type SubtitleCues,
	type SubtitleReading
} from "@/features/preview/lib/subtitleCues.logic"
import { encodingShortName } from "@/features/preview/lib/textFile"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { Input } from "@/components/ui/input"
import { log } from "@/lib/log"

type ReadingState = { status: "pending" } | { status: "done"; reading: SubtitleReading } | { status: "failed" }

// The cues read in the text-family worker from the text the page decoded.
function useSubtitleReading(text: string, extension: string): ReadingState {
	const [state, setState] = useState<ReadingState>({ status: "pending" })

	useEffect(() => {
		let live = true

		readSubtitleCues(text, extension).then(
			reading => {
				if (live) setState({ status: "done", reading })
			},
			(e: unknown) => {
				log.error("preview", "reading subtitles failed", e)

				if (live) setState({ status: "failed" })
			}
		)

		return () => {
			live = false
		}
	}, [text, extension])

	return state
}

const ROW_ESTIMATE = 36
const OVERSCAN = 12
const COLUMNS = "4rem 7.5rem 7.5rem 4.5rem minmax(0, 1fr)"

function CueRows({ cues, matches }: { cues: SubtitleCues; matches: Int32Array | null }) {
	const { t } = useTranslation("preview")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const count = matches === null ? cues.texts.length : matches.length
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_ESTIMATE,
		overscan: OVERSCAN
	})
	const headers = [
		t("previewSubtitlesNumber"),
		t("previewSubtitlesStart"),
		t("previewSubtitlesEnd"),
		t("previewSubtitlesDuration"),
		t("previewSubtitlesText")
	]

	return (
		<div
			role="table"
			aria-label={t("previewSubtitlesTable")}
			aria-rowcount={count + 1}
			className="flex min-h-0 flex-1 flex-col text-sm"
		>
			<div
				role="row"
				aria-rowindex={1}
				className="grid gap-x-4 border-b border-border/50 px-4 py-2 text-xs font-medium text-muted-foreground"
				style={{ gridTemplateColumns: COLUMNS }}
			>
				{headers.map((header, index) => (
					<span
						key={index}
						role="columnheader"
						className={index === 0 || index === 3 ? "text-end" : "text-start"}
					>
						{header}
					</span>
				))}
			</div>
			<div
				ref={setScrollElement}
				role="rowgroup"
				className="min-h-0 flex-1 overflow-y-auto"
			>
				<div
					className="relative w-full"
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualizer.getVirtualItems().map(virtualRow => {
						const index = matches === null ? virtualRow.index : (matches[virtualRow.index] ?? 0)
						const start = cues.starts[index] ?? 0
						const end = cues.ends[index] ?? 0

						return (
							<div
								key={virtualRow.key}
								ref={virtualizer.measureElement}
								data-index={virtualRow.index}
								role="row"
								aria-rowindex={virtualRow.index + 2}
								className="absolute top-0 left-0 grid w-full gap-x-4 border-b border-border/30 px-4 py-2 select-text"
								style={{ gridTemplateColumns: COLUMNS, transform: `translateY(${String(virtualRow.start)}px)` }}
							>
								<span
									role="cell"
									className="text-end text-muted-foreground tabular-nums"
								>
									{index + 1}
								</span>
								<span
									role="cell"
									className="font-mono text-xs leading-5 tabular-nums"
								>
									{formatCueTime(start)}
								</span>
								<span
									role="cell"
									className="font-mono text-xs leading-5 tabular-nums"
								>
									{formatCueTime(end)}
								</span>
								<span
									role="cell"
									className="text-end text-muted-foreground tabular-nums"
								>
									{t("previewSubtitlesSeconds", { seconds: (end - start).toFixed(1) })}
								</span>
								<span
									role="cell"
									className="break-words whitespace-pre-wrap"
								>
									<bdi>{cues.texts[index]}</bdi>
								</span>
							</div>
						)
					})}
				</div>
			</div>
		</div>
	)
}

function CueTable({ cues, format, encoding }: { cues: SubtitleCues; format: string; encoding: string }) {
	const { t } = useTranslation("preview")
	const [query, setQuery] = useState("")
	// Once per reading: the compiler keeps it while `cues` stays.
	const lowered = cues.texts.map(text => text.toLowerCase())
	const matches = matchingCues(lowered, query)

	return (
		<div className="flex size-full flex-col">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/50 px-4 py-2">
				<p className="min-w-0 flex-1 text-xs text-muted-foreground">
					{t("previewSubtitlesSummary", {
						format,
						count: cues.texts.length,
						encoding: encodingShortName(encoding),
						span: formatCueSpan(cuesSpan(cues))
					})}
					{matches === null ? null : ` · ${t("previewSubtitlesMatches", { count: matches.length })}`}
				</p>
				<Input
					type="search"
					value={query}
					onChange={event => {
						setQuery(event.target.value)
					}}
					placeholder={t("previewSubtitlesFind")}
					aria-label={t("previewSubtitlesFind")}
					className="h-8 w-56 max-w-full leading-5"
				/>
			</div>
			<CueRows
				cues={cues}
				matches={matches}
			/>
		</div>
	)
}

function CuesView({ source, extension }: { source: RenderedSource; extension: string }) {
	const { t } = useTranslation("preview")
	const state = useSubtitleReading(source.file.text, extension)

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	if (state.status === "failed") {
		return <PreviewErrorState message={t("previewSubtitlesFailed")} />
	}

	if (state.reading.status !== "ok") {
		return <PreviewErrorState message={t("previewSubtitlesUnreadable")} />
	}

	return (
		<CueTable
			cues={state.reading}
			format={extension.toUpperCase()}
			encoding={source.file.encoding}
		/>
	)
}

function renderCues(source: RenderedSource, extension: string) {
	return (
		<CuesView
			source={source}
			extension={extension}
		/>
	)
}

// A subtitle file: its cues as a table, its source a toggle away. Above the table's cap, its text alone.
// No parameter defaults: the React Compiler skips a component that has them.
export function SubtitleViewer({ item, alt, editable, onDirtyChange, contentRef, locked, onTextState, readAs }: TextViewerProps) {
	const { t } = useTranslation("preview")
	const extension = itemTypeExtension(item)
	const optional = {
		...(editable === undefined ? {} : { editable }),
		...(onDirtyChange === undefined ? {} : { onDirtyChange }),
		...(contentRef === undefined ? {} : { contentRef }),
		...(locked === undefined ? {} : { locked }),
		...(onTextState === undefined ? {} : { onTextState }),
		...(readAs === undefined ? {} : { readAs })
	}

	if (asDirectoryOrFile(item).data.size > SUBTITLE_TABLE_MAX_BYTES) {
		return (
			<TextViewer
				item={item}
				alt={alt}
				{...optional}
			/>
		)
	}

	return (
		<RenderedSourceViewer
			item={item}
			alt={alt}
			renderer={source => renderCues(source, extension)}
			tag={codeMirrorLanguageFor(extension)}
			formatting={false}
			labels={{ view: t("previewSubtitlesView"), rendered: t("previewSubtitlesCues") }}
			{...optional}
		/>
	)
}
