import { masterOfLayout, type DesignThemeInfo, type PresentationDesignInfo, type SlideRef } from "@filen/office/core/presentation"
import type { PresentationEditor } from "@/features/presentation/hooks/usePresentationSession"

// The deck's design as the Design tab reads it: its themes (OpenInfo.design), the current slide's master and its theme.

const NO_DESIGN: PresentationDesignInfo = { themes: [] }

export function designState(editor: PresentationEditor | undefined): {
	readonly design: PresentationDesignInfo
	readonly master: SlideRef | undefined
	readonly current: DesignThemeInfo | undefined
} {
	const design = editor?.document.info?.design ?? NO_DESIGN
	const master = editor === undefined ? undefined : masterOfLayout(editor.layouts, editor.currentLayout)

	return { design, master, current: design.themes.find(theme => theme.master === master) }
}
