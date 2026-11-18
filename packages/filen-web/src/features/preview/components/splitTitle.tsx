import type { ReactNode } from "react"
import { previewTitleSplitIndex } from "@/features/preview/lib/previewTitle"

// A long title as a head that truncates to the width there is and a tail of `tailLength` that stays in view: one
// ellipsis, in the middle. Both halves keep their spaces (white-space: pre): a space at the split sits at a line edge,
// where nowrap would drop it.
export function SplitTitle({ text, tailLength }: { text: string; tailLength: number }): ReactNode {
	const splitAt = previewTitleSplitIndex(text, tailLength)

	if (splitAt === 0) return <span className="truncate">{text}</span>

	// The halves are flex items, and an accessible name puts a space between blocks ("e 2e-notes.zip"): assistive
	// technology reads the whole text instead.
	return (
		<>
			<span className="sr-only">{text}</span>
			<span
				aria-hidden="true"
				className="min-w-0 overflow-hidden text-ellipsis whitespace-pre"
			>
				{text.slice(0, splitAt)}
			</span>
			<span
				aria-hidden="true"
				className="shrink-0 whitespace-pre"
			>
				{text.slice(splitAt)}
			</span>
		</>
	)
}
