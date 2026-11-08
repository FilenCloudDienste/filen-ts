import type { Node } from "prosemirror-model"
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { latexToOmml } from "../../../math/latex"
import { editedEquation, equationFault, equationRunProperties, mathNodeLatex, newEquation } from "../../math/edit"
import type { XElement } from "../../../math/ommlTrack"
import { formattingBase, revisionStamp, type RevisionStamp } from "../../review/track"
import type { MathCommand } from "../commands/math"
import { caretMarks } from "../formats"
import { markCommand } from "../invariants/index"
import type { FeatureHandlers, StoryCommandContext, StoryCommandHandler } from "../registry"
import { NO_MARKERS, NO_SOURCE, docxSchema } from "../schema"

// Equations from LaTeX: a new one at the caret (inline, or a display equation in a paragraph of its own, as
// Word places one), and new OMML for the equation the selection is.
//
// While changes are tracked both are recorded inside the equation, as Word records them (math/ommlTrack.ts): a new
// equation's runs and objects inserted, an edit as the difference between the equation and the new one.

const nodes = docxSchema.nodes

type Cmd<T extends MathCommand["type"]> = Extract<MathCommand, { readonly type: T }>

function inParagraph(state: EditorState): boolean {
	const { $from, $to } = state.selection

	return $from.parent.type === nodes.paragraph && $to.parent.type === nodes.paragraph
}

function writable(context: StoryCommandContext): boolean {
	return !context.session.readOnly
}

// Who records a change now, while changes are tracked (undefined: not tracked; null: no author to record it).
function tracking(context: StoryCommandContext): RevisionStamp | null | undefined {
	return context.context.review.tracking ? (revisionStamp(context.context.identity) ?? null) : undefined
}

function selectedEquation(state: EditorState): { readonly pos: number; readonly node: Node } | undefined {
	const selection = state.selection

	return selection instanceof NodeSelection && selection.node.type === nodes.math
		? { pos: selection.from, node: selection.node }
		: undefined
}

// The run properties where a new equation goes in (the caret's), in Word's math font.
function caretRunProperties(context: StoryCommandContext): XElement {
	const { $from, empty, $to } = context.state.selection
	const marksAt = empty ? caretMarks(context.state, context.session.formats) : ($from.marksAcross($to) ?? $from.marks())
	const id = formattingBase(context.context, context.session.story.part, marksAt)

	return equationRunProperties(id < 0 ? undefined : context.context.bases.get(id))
}

function insert(context: StoryCommandContext, command: Cmd<"equation.insert">): Transaction | null {
	const written = latexToOmml(command.latex, command.display)

	if (!written.ok) return null

	const stamp = tracking(context)

	if (stamp === null) return null

	const omml = newEquation(
		written.omml,
		caretRunProperties(context),
		stamp === undefined ? undefined : { id: context.context.ids.next("revision"), stamp }
	)
	// What could not be saved is refused here, never at the save.
	if (equationFault(omml, context.session.story.part) !== undefined) return null

	const node = nodes.math.create({ src: NO_SOURCE, display: command.display, markers: NO_MARKERS, omml })
	const state = context.state

	if (!command.display) return state.tr.replaceSelectionWith(node, false).scrollIntoView()

	// A display equation is the only content of its paragraph: in a paragraph of its own (the caret's style)
	// between the text before and after the caret.
	const tr = state.tr.deleteSelection()
	const $pos = tr.doc.resolve(tr.selection.from)
	const paragraph = $pos.parent

	if (paragraph.type !== nodes.paragraph) return null

	if (paragraph.content.size === 0) {
		tr.insert($pos.pos, node)

		return tr.setSelection(TextSelection.create(tr.doc, $pos.pos + node.nodeSize)).scrollIntoView()
	}

	let at: number

	if ($pos.parentOffset === 0) {
		at = $pos.before()
	} else if ($pos.parentOffset === paragraph.content.size) {
		// At a paragraph's end the caret's paragraph mark is the new one (Enter there, as Word records it while
		// tracking: the mark that ends the text is inserted, the paragraph's own goes on with the equation).
		tr.split($pos.pos)
		tr.insert($pos.pos + 2, node)

		return tr.setSelection(TextSelection.create(tr.doc, $pos.pos + 2 + node.nodeSize)).scrollIntoView()
	} else {
		tr.split($pos.pos)
		at = $pos.pos + 1
	}

	tr.insert(at, nodes.paragraph.create({ styleId: paragraph.attrs["styleId"] as string | null }, node))

	return tr.setSelection(TextSelection.create(tr.doc, at + 1 + node.nodeSize)).scrollIntoView()
}

function edit(context: StoryCommandContext, command: Cmd<"equation.edit">): Transaction | true | null {
	const found = selectedEquation(context.state)

	if (found === undefined) return null

	const display = found.node.attrs["display"] === true
	const current = mathNodeLatex(found.node, context.session.story.part)

	// The same equation: nothing to write (one from the file stays its bytes).
	if (!current.lossy && current.latex === command.latex) return true

	const written = latexToOmml(command.latex, display)
	const stamp = tracking(context)

	if (!written.ok || stamp === null) return null
	if (written.omml === found.node.attrs["omml"]) return true

	const ids = context.context.ids
	// The edit applied to the equation as it is: its formatting, and the changes it holds, stay.
	const omml = editedEquation(
		found.node,
		context.session.story.part,
		written.omml,
		stamp ?? { author: "", date: "" },
		stamp === undefined ? undefined : { insertion: ids.next("revision"), deletion: ids.next("revision") }
	)

	if (omml === undefined || equationFault(omml, context.session.story.part) !== undefined) return null

	const tr = context.state.tr.setNodeAttribute(found.pos, "omml", omml)

	return markCommand(tr.setSelection(NodeSelection.create(tr.doc, found.pos)).scrollIntoView())
}

function handler<T extends MathCommand["type"]>(
	run: (context: StoryCommandContext, command: Cmd<T>) => Transaction | true | null,
	enabled: (context: StoryCommandContext) => boolean
): StoryCommandHandler<T> {
	return { enabled, run: (context, command) => (enabled(context) ? run(context, command as Cmd<T>) : null) }
}

export const MATH_HANDLERS: FeatureHandlers = {
	story: {
		"equation.insert": handler(insert, context => writable(context) && inParagraph(context.state)),
		"equation.edit": handler(edit, context => writable(context) && selectedEquation(context.state) !== undefined)
	}
}
