import { EditorView } from "@codemirror/view"

// The CodeMirror view a rendered editor mounted inside the container.
export function editorView(container: HTMLElement): EditorView {
	const dom = container.querySelector<HTMLElement>(".cm-editor")
	const view = dom === null ? null : EditorView.findFromDOM(dom)

	if (view === null) {
		throw new Error("no editor view")
	}

	return view
}
