import { useSecureStore } from "@/lib/secureStore"

// Markdown preview on/off, per editor id.
export type TextEditorMarkdownPreviewActive = Record<string, boolean>

export const TEXT_EDITOR_MARKDOWN_PREVIEW_ACTIVE_SECURE_STORE_KEY = "textEditorMarkdownPreviewActive"

export const DEFAULT_TEXT_EDITOR_MARKDOWN_PREVIEW_ACTIVE: TextEditorMarkdownPreviewActive = {}

export function useTextEditorMarkdownPreviewActive(): [
	TextEditorMarkdownPreviewActive,
	(next: TextEditorMarkdownPreviewActive | ((prev: TextEditorMarkdownPreviewActive) => TextEditorMarkdownPreviewActive)) => void
] {
	return useSecureStore<TextEditorMarkdownPreviewActive>(
		TEXT_EDITOR_MARKDOWN_PREVIEW_ACTIVE_SECURE_STORE_KEY,
		DEFAULT_TEXT_EDITOR_MARKDOWN_PREVIEW_ACTIVE
	)
}
