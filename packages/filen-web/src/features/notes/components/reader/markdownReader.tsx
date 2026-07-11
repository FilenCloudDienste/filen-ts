import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { MarkdownSplitPane } from "@/features/notes/components/markdownSplitPane"
import type { Note } from "@filen/sdk-rs"

// md note render (read-only — the trashed/history path). A resizable horizontal split:
// source on the left (read-only CodeMirror in markdown mode), the SAME rendered-markdown surface
// file preview's own markdownViewer.tsx uses on the right. The writable path is NoteMarkdownEditor,
// which reuses the SAME MarkdownSplitPane with an editable left pane.
export function MarkdownReader({ note, content }: { note: Note; content: string }) {
	return (
		<MarkdownSplitPane
			left={
				<CodeMirrorSource
					text={content}
					tag="markdown"
					alt={note.title ?? ""}
					editable={false}
				/>
			}
			right={
				<MarkdownRenderer
					text={content}
					alt={note.title ?? ""}
				/>
			}
		/>
	)
}
