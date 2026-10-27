import { PanelTopIcon } from "lucide-react"
import { NewSlideControl } from "@/features/presentation/components/slideControls"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"

// The presentation ribbon's Insert groups that are the editor's own: New slide first, as in PowerPoint (the
// objects, charts, media and SmartArt groups come from their own files).
export const insertGroups: PresentationGroups = context =>
	context.editable
		? [
				{
					id: "slides",
					label: context.t("previewPptxRibbonSlides", { ns: "preview" }),
					icon: PanelTopIcon,
					width: 124,
					priority: 5,
					single: true,
					content: <NewSlideControl />
				}
			]
		: []
