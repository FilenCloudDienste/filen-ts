import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"

// rich note render — sanitized static HTML (live-edit Quill lands next wave). Untrusted participant
// HTML is DOMPurify-sanitized with mobile's exact allowlist before it ever reaches
// dangerouslySetInnerHTML (01-DECISIONS D1) — this component never receives raw content directly, only
// through sanitizeRichTextHtml, so there is no path from note content to script execution.
export function RichReader({ content }: { content: string }) {
	return (
		<div
			className="size-full overflow-auto px-6 py-4 text-sm leading-6 select-text [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:leading-6 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:mb-3 [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5"
			dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(content) }}
		/>
	)
}
