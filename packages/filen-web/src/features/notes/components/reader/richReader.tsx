import { richReaderHtml } from "@/features/notes/components/reader/richReader.logic"

// rich note render — sanitized static HTML. NoteReaderByType only mounts this for read-only contexts
// (a trashed/non-writable note, or the history dialog's preview); the live-editable path is
// richTextEditor.tsx. Untrusted participant
// HTML is DOMPurify-sanitized with mobile's exact allowlist before it ever reaches
// dangerouslySetInnerHTML — this component never receives raw content directly, only
// through sanitizeRichTextHtml, so there is no path from note content to script execution. Lists
// arrive in Quill 1's form (richReaderHtml): a checklist is a <ul data-checked> whose state is drawn as
// the list marker, and nesting is a ql-indent-N class on a flat <li> numbered per level by the
// notes-rich-reader counters in index.css.
export function RichReader({ content }: { content: string }) {
	return (
		<div
			className="notes-rich-reader size-full overflow-auto px-6 py-4 text-sm leading-6 select-text [&_.ql-indent-1]:ml-[3em] [&_.ql-indent-2]:ml-[6em] [&_.ql-indent-3]:ml-[9em] [&_.ql-indent-4]:ml-[12em] [&_.ql-indent-5]:ml-[15em] [&_.ql-indent-6]:ml-[18em] [&_.ql-indent-7]:ml-[21em] [&_.ql-indent-8]:ml-[24em] [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:leading-6 [&_ol]:mb-3 [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:mb-3 [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_ul[data-checked=false]]:list-['☐_'] [&_ul[data-checked=true]]:list-['☑_'] [&_ul[data-checked=true]]:text-muted-foreground [&_ul[data-checked=true]]:line-through"
			dangerouslySetInnerHTML={{ __html: richReaderHtml(content) }}
		/>
	)
}
