import { isolateHistory } from "@codemirror/commands"
import { syntaxTree } from "@codemirror/language"
import type { EditorState, TransactionSpec } from "@codemirror/state"

// The live preview's edits and lookups on the source (livePreview.ts): the task box's toggle and the link under a
// Mod+click.

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"]

// The task marker at `pos` ("[ ]" or "[x]") flipped, as an undo step of its own (never merged with typing next to
// it); null where no marker starts.
export function toggleTask(state: EditorState, pos: number): TransactionSpec | null {
	const node = syntaxTree(state).resolveInner(pos, 1)

	if (node.name !== "TaskMarker" || node.from !== pos) {
		return null
	}

	const mark = state.sliceDoc(pos + 1, pos + 2)

	return {
		changes: { from: pos + 1, to: pos + 2, insert: mark === " " ? "x" : " " },
		annotations: isolateHistory.of("full"),
		userEvent: "input.toggle"
	}
}

// Reference labels match case-insensitively, whitespace collapsed (CommonMark).
function normalizeLabel(label: string): string {
	return label.slice(1, -1).trim().replace(/\s+/g, " ").toLowerCase()
}

// A reference link's target: the first definition of its label. Read on demand (a Mod+click), never per keystroke.
function referenceUrl(state: EditorState, label: string): string | null {
	const wanted = normalizeLabel(label)

	for (let node = syntaxTree(state).topNode.firstChild; node !== null; node = node.nextSibling) {
		if (node.name !== "LinkReference") {
			continue
		}

		const name = node.getChild("LinkLabel")
		const url = node.getChild("URL")

		if (name !== null && url !== null && normalizeLabel(state.sliceDoc(name.from, name.to)) === wanted) {
			return state.sliceDoc(url.from, url.to)
		}
	}

	return null
}

function linkTarget(state: EditorState, node: SyntaxNode): string | null {
	const url = node.getChild("URL")

	if (url !== null) {
		const text = state.sliceDoc(url.from, url.to)

		// <spaced url> keeps its angle brackets in the node.
		return text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text
	}

	const label = node.getChild("LinkLabel")
	const marks = node.getChildren("LinkMark")
	const close = marks[1]
	// [text][label], or [text] alone (its own label); a footnote ([^1]) is no link.
	const name = label !== null ? state.sliceDoc(label.from, label.to) : close === undefined ? "" : state.sliceDoc(node.from, close.to)

	return name.startsWith("[^") || name.length < 3 ? null : referenceUrl(state, name)
}

// The URL of the link (inline, reference, autolink or bare URL) at `pos`, as written; null where none is.
export function linkAt(state: EditorState, pos: number): string | null {
	for (const side of [1, -1] as const) {
		for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node !== null; node = node.parent) {
			if (node.name === "Link") {
				return linkTarget(state, node)
			}

			if (node.name === "Autolink") {
				const url = node.getChild("URL")

				return url === null ? null : state.sliceDoc(url.from, url.to)
			}

			if (node.name === "URL" && node.parent?.name !== "LinkReference" && node.parent?.name !== "Image") {
				return state.sliceDoc(node.from, node.to)
			}

			if (node.name === "Image" || node.name === "Paragraph" || node.name === "Document") {
				break
			}
		}
	}

	return null
}
