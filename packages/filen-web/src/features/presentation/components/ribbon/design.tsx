import { PaletteIcon, SlidersHorizontalIcon, SwatchBookIcon } from "lucide-react"
import { BackgroundControl } from "@/features/presentation/components/design/backgroundDialog"
import { SlideSizeControl } from "@/features/presentation/components/design/slideSizeDialog"
import { ThemesControl, VariantsControl } from "@/features/presentation/components/design/themeGallery"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"

// The presentation ribbon's Design tab: Themes (the presentation's own and Filen's), Variants (the colour variants of
// the current slide's Filen theme), and Customize (slide size, Format Background). Only in an editable deck.

// Widths with their gaps, as the browsers lay the controls out (ribbonFit's estimates).
const THEMES = 96
const VARIANTS = 4 * 46
const SLIDE_SIZE = 108
const BACKGROUND = 168

export const designGroups: PresentationGroups = context =>
	!context.editable || context.editor === undefined
		? []
		: [
				{
					id: "themes",
					label: context.t("previewPptxDesignThemesGroup", { ns: "preview" }),
					icon: PaletteIcon,
					width: THEMES,
					priority: 3,
					single: true,
					content: <ThemesControl />
				},
				{
					id: "variants",
					label: context.t("previewPptxDesignVariantsGroup", { ns: "preview" }),
					icon: SwatchBookIcon,
					width: VARIANTS,
					priority: 1,
					content: <VariantsControl />
				},
				{
					id: "customize",
					label: context.t("previewPptxDesignCustomizeGroup", { ns: "preview" }),
					icon: SlidersHorizontalIcon,
					width: SLIDE_SIZE + BACKGROUND,
					priority: 2,
					content: (
						<>
							<SlideSizeControl />
							<BackgroundControl />
						</>
					)
				}
			]
