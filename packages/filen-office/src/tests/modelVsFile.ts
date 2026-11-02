import { compose, groupAffine, IDENTITY, placed, type Affine } from "../core/odp/write/emit/shape"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import type { SmartArtInfo } from "../core/smartart/edit"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { review } from "../dom/presentation/engine/review"
import { smartartCapability, smartArtRenderer } from "../dom/presentation/engine/smartart"
import { driveSession } from "./odpWriteDrive"

// What a session shows against what a fresh open of the file it saved shows: per slide in order, whether it is
// hidden; every shape (kind, hidden, text, box, table cell texts, a diagram's layout, style, colours and node texts);
// the notes text; the comments (author, text, reply, resolved). The two must agree after every written save.

type Drive = Awaited<ReturnType<typeof driveSession>>
type Format = "pptx" | "odp"

function plain(shape: { readonly text?: ShapeNode["text"] }): string {
	return shape.text?.paragraphs.map(paragraph => paragraph.runs.map(run => ("text" in run ? run.text : "")).join("")).join("/") ?? ""
}

// ODP boxes are written in cm: compared at 400 EMU (0.001 cm is 360 EMU).
function rounded(value: number | undefined, quantum: number): number | undefined {
	return value === undefined ? undefined : Math.round(value / quantum)
}

// Boxes as drawn, in slide space: a member's box through its groups' mappings (a group moved or resized maps its
// members' child space anew, and the reader and the model may keep different child spaces for one drawing). A group's
// own box is the union of its members', checked through them.
async function shapeLines(
	d: Drive,
	slide: SlideRef,
	shapes: readonly ShapeNode[],
	quantum: number,
	out: string[],
	depth: number,
	mapping: Affine
): Promise<void> {
	for (const shape of shapes) {
		const box = shape.children !== undefined || shape.xfrm === undefined ? undefined : placed(shape.xfrm, mapping)
		let frame = ""

		if (shape.frame?.kind === "table")
			frame = `table ${JSON.stringify(shape.frame.table.rows.map(row => row.cells.map(cell => plain(cell as { readonly text?: ShapeNode["text"] }))))}`
		else if (shape.frame?.kind === "smartart") {
			try {
				const info = (await smartartCapability.info(d.session, { slide, id: shape.id })) as SmartArtInfo | undefined

				frame = `diagram ${info?.layout ?? ""}|${info?.style ?? ""}|${info?.colors ?? ""}|${(info?.nodes ?? [])
					.map(node => (node as { readonly text?: string }).text ?? "")
					.join(",")}`
			} catch (error) {
				frame = `diagram unreadable ${String(error).slice(0, 60)}`
			}
		} else if (shape.frame !== undefined) frame = shape.frame.kind

		const place =
			box === undefined
				? "-"
				: [
						rounded(box.x, quantum),
						rounded(box.y, quantum),
						rounded(box.cx, quantum),
						rounded(box.cy, quantum),
						rounded(box.rot, 60_000),
						box.flipH ? 1 : 0,
						box.flipV ? 1 : 0
					].join(",")

		out.push(`${"  ".repeat(depth)}${shape.kind}${shape.hidden ? " hidden" : ""} "${plain(shape)}" ${place} ${frame}`)

		if (shape.children !== undefined) {
			const inner = groupAffine(shape.xfrm)

			await shapeLines(d, slide, shape.children, quantum, out, depth + 1, "kind" in inner ? mapping : compose(mapping, inner))
		}
	}
}

// The deck as `d` shows it, one entry per slide.
export async function deckSummary(d: Drive, format: Format): Promise<string[]> {
	const quantum = format === "odp" ? 400 : 1
	const out: string[] = []

	for (const ref of d.session.deck.slides) {
		const reviewed = await review(d.context, ref)
		const node = d.session.deck.nodes.get(ref)
		const lines: string[] = []

		if (node !== undefined) await shapeLines(d, ref, node.shapes, quantum, lines, 0, IDENTITY)

		const comments = reviewed.comments.map(
			comment =>
				`${comment.author}:${comment.text}${comment.parent === undefined ? "" : " reply"}${comment.resolved ? " resolved" : ""}`
		)

		out.push(
			`slide${node?.hidden === true ? " hidden" : ""}\n${lines.join("\n")}\n notes "${reviewed.notesText.trim()}"\n comments ${JSON.stringify(comments)}`
		)
	}

	return out
}

// A session over saved bytes, as the page opens them (diagrams laid out like the session's).
export async function reopened(bytes: Uint8Array, format: Format): Promise<Drive> {
	const d = await driveSession(bytes, format)

	if (format === "pptx")
		smartArtRenderer(d.session, {
			services: {
				xml: part => pptxParts(d.session.deck)?.document(part),
				relationship: () => undefined,
				contentType: () => undefined
			}
		})

	return d
}

// "" when the session and a fresh open of `bytes` show the same deck; otherwise the first slide line that differs.
export async function modelVsFile(d: Drive, bytes: Uint8Array, format: Format): Promise<string> {
	const model = await deckSummary(d, format)
	const file = await deckSummary(await reopened(bytes, format), format)

	if (model.length !== file.length) return `slide count: model ${String(model.length)}, file ${String(file.length)}`

	const slide = model.findIndex((text, at) => text !== file[at])

	if (slide < 0) return ""

	const left = (model[slide] ?? "").split("\n")
	const right = (file[slide] ?? "").split("\n")
	const line = left.findIndex((text, at) => text !== right[at])

	return `slide ${String(slide)} line ${String(line)}: model ${left[line]?.slice(0, 300) ?? ""} | file ${right[line]?.slice(0, 300) ?? ""}`
}
