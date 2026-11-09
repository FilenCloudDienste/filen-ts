import type { CSSProperties, ReactNode } from "react"
import type { NotesParagraph, NotesRun } from "../../../core/presentation/output"

// Speaker notes read-only, as PowerPoint's Presenter view shows them (SlideRender.notes): bold, italic, underline,
// strikethrough, superscript and subscript, alignment, indents and bullets or numbers. Font, size and colour are the
// container's: the text takes the size the presenter picks, indents and markers scale with it.

const ALIGN = { ctr: "center", r: "right", just: "justify" } as const

function runOf(run: NotesRun, key: number): ReactNode {
	const decoration = [run.u === true ? "underline" : "", run.strike === true ? "line-through" : ""].filter(Boolean).join(" ")
	const style: CSSProperties | undefined =
		run.b === true || run.i === true || decoration !== ""
			? {
					...(run.b === true ? { fontWeight: 700 } : {}),
					...(run.i === true ? { fontStyle: "italic" } : {}),
					...(decoration === "" ? {} : { textDecorationLine: decoration })
				}
			: undefined

	if (run.script !== undefined) {
		const Script = run.script

		return (
			<Script
				key={key}
				style={style}
			>
				{run.text}
			</Script>
		)
	}

	return style === undefined ? (
		<span key={key}>{run.text}</span>
	) : (
		<span
			key={key}
			style={style}
		>
			{run.text}
		</span>
	)
}

function paragraphOf(paragraph: NotesParagraph, key: number): ReactNode {
	// The marker never sits left of the paragraph's box.
	const start = Math.max(0, paragraph.start)
	const first = Math.max(-start, paragraph.first)
	const hanging = paragraph.marker !== undefined && first < 0

	return (
		<p
			key={key}
			dir={paragraph.rtl === true ? "rtl" : undefined}
			style={{
				margin: 0,
				whiteSpace: "pre-wrap",
				paddingInlineStart: `${String(start)}em`,
				textIndent: `${String(first)}em`,
				...(paragraph.align === undefined ? {} : { textAlign: ALIGN[paragraph.align] })
			}}
		>
			{paragraph.marker === undefined ? null : (
				<span style={hanging ? { display: "inline-block", minWidth: `${String(-first)}em`, textIndent: 0 } : undefined}>
					{hanging ? paragraph.marker : `${paragraph.marker}\u00a0`}
				</span>
			)}
			{paragraph.runs.length === 0 ? <br /> : paragraph.runs.map(runOf)}
		</p>
	)
}

export function NotesText({ paragraphs }: { readonly paragraphs: readonly NotesParagraph[] }) {
	return paragraphs.map(paragraphOf)
}
