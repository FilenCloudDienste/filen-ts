import { PanelLeftIcon } from "lucide-react"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"
import { PaneToggles } from "@/features/presentation/components/slideControls"

// The presentation ribbon's View groups: the slide list and the notes pane shown or hidden. Offered in a deck that
// can only be viewed too.

const BUTTON = 30

export const viewGroups: PresentationGroups = context => [
	{
		id: "panes",
		label: context.t("previewPptxRibbonPanes", { ns: "preview" }),
		icon: PanelLeftIcon,
		width: 2 * BUTTON,
		priority: 3,
		content: <PaneToggles />
	}
]
