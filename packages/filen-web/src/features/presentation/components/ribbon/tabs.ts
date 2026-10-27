import type { TFunction } from "i18next"
import type { DeckOp } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideRender } from "@filen/office/dom/presentation"
import type { ShapeSelection, TextEditing } from "@filen/office/react/presentation"
import type { RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { animationsGroups } from "@/features/presentation/components/ribbon/animations"
import { arrangeGroups } from "@/features/presentation/components/ribbon/arrange"
import { audioGroups } from "@/features/presentation/components/ribbon/audio"
import { chartGroups } from "@/features/presentation/components/ribbon/chart"
import { designGroups } from "@/features/presentation/components/ribbon/design"
import { homeEditingGroups, homeGroups } from "@/features/presentation/components/ribbon/home"
import { homeTextGroups } from "@/features/presentation/components/ribbon/homeText"
import { insertGroups } from "@/features/presentation/components/ribbon/insert"
import { insertChartsGroups } from "@/features/presentation/components/ribbon/insertCharts"
import { insertMediaGroups } from "@/features/presentation/components/ribbon/insertMedia"
import { insertObjectsGroups } from "@/features/presentation/components/ribbon/insertObjects"
import { insertSmartArtGroups } from "@/features/presentation/components/ribbon/insertSmartArt"
import { motionPathsGroups } from "@/features/presentation/components/ribbon/motionPaths"
import { pictureGroups } from "@/features/presentation/components/ribbon/picture"
import { reviewGroups } from "@/features/presentation/components/ribbon/review"
import { shapeFormatGroups } from "@/features/presentation/components/ribbon/shapeFormat"
import { slideShowGroups } from "@/features/presentation/components/ribbon/slideShow"
import { smartartDesignGroups } from "@/features/presentation/components/ribbon/smartartDesign"
import { smartartFormatGroups } from "@/features/presentation/components/ribbon/smartartFormat"
import { tableGroups } from "@/features/presentation/components/ribbon/table"
import { transitionsGroups } from "@/features/presentation/components/ribbon/transitions"
import { videoGroups } from "@/features/presentation/components/ribbon/video"
import { viewGroups } from "@/features/presentation/components/ribbon/view"

// The presentation editor's ribbon: its tabs in order, each listing its group files in order. Every group file has
// one owner, so a slice adds its commands without touching another's file or this list.

export type PresentationTabId = "home" | "insert" | "design" | "transitions" | "animations" | "slideShow" | "review" | "view" | "arrange"

export type PresentationContextualTabId =
	"shapeFormat" | "picture" | "table" | "chart" | "video" | "audio" | "smartartDesign" | "smartartFormat"

// What the selection holds, for the contextual tabs.
export type PresentationSelectionKind = "shape" | "text" | "picture" | "table" | "chart" | "video" | "audio" | "smartart"

// The editor a group's commands act on (absent in the viewer).
export interface PresentationRibbonEditor {
	readonly info: OpenInfo
	// The slide in view.
	readonly render: SlideRender | undefined
	// The shapes selected on it (the canvas, the ribbon and the keys share one store).
	readonly selection: ShapeSelection
	// Runs one op through the session; the shell reports a refusal before it resolves.
	command(op: DeckOp): Promise<CommandResult>
	readonly session: PresentationSessionApi
	// The text editing store (the body open in the text editor, its flush).
	readonly text?: TextEditing
}

export interface PresentationRibbonContext {
	readonly editable: boolean
	readonly phone: boolean
	readonly selection: ReadonlySet<PresentationSelectionKind>
	readonly t: TFunction
	readonly editor?: PresentationRibbonEditor
}

// A group file: the groups it adds to its tab for this context (none when they do not apply).
export type PresentationGroups = (context: PresentationRibbonContext) => readonly RibbonGroup[]

export type PresentationTab =
	| { readonly id: PresentationTabId; readonly groups: readonly PresentationGroups[] }
	| {
			readonly id: PresentationContextualTabId
			readonly groups: readonly PresentationGroups[]
			readonly selection: readonly PresentationSelectionKind[]
	  }

export const PRESENTATION_TABS: readonly PresentationTab[] = [
	{ id: "home", groups: [homeGroups, homeTextGroups, homeEditingGroups] },
	{ id: "insert", groups: [insertGroups, insertObjectsGroups, insertChartsGroups, insertMediaGroups, insertSmartArtGroups] },
	{ id: "design", groups: [designGroups] },
	{ id: "transitions", groups: [transitionsGroups] },
	{ id: "animations", groups: [animationsGroups, motionPathsGroups] },
	{ id: "slideShow", groups: [slideShowGroups] },
	{ id: "review", groups: [reviewGroups] },
	{ id: "view", groups: [viewGroups] },
	{ id: "arrange", groups: [arrangeGroups] },
	{ id: "shapeFormat", groups: [shapeFormatGroups], selection: ["shape", "text"] },
	{ id: "picture", groups: [pictureGroups], selection: ["picture"] },
	{ id: "table", groups: [tableGroups], selection: ["table"] },
	{ id: "chart", groups: [chartGroups], selection: ["chart"] },
	{ id: "video", groups: [videoGroups], selection: ["video"] },
	{ id: "audio", groups: [audioGroups], selection: ["audio"] },
	{ id: "smartartDesign", groups: [smartartDesignGroups], selection: ["smartart"] },
	{ id: "smartartFormat", groups: [smartartFormatGroups], selection: ["smartart"] }
]

// The tabs shown for `context`: the fixed ones, then the contextual ones whose object is selected.
export function presentationTabs(context: PresentationRibbonContext): readonly PresentationTab[] {
	return PRESENTATION_TABS.filter(tab => !("selection" in tab) || tab.selection.some(kind => context.selection.has(kind)))
}

export function presentationTabGroups(tab: PresentationTab, context: PresentationRibbonContext): readonly RibbonGroup[] {
	return tab.groups.flatMap(groups => groups(context))
}
