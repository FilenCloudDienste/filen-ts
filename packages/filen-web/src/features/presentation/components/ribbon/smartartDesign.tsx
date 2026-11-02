import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	ArrowDownIcon,
	ArrowUpIcon,
	IndentDecreaseIcon,
	IndentIncreaseIcon,
	LayoutGridIcon,
	PaletteIcon,
	PanelLeftIcon,
	PlusIcon,
	SparklesIcon
} from "lucide-react"
import type { SmartArtDefRef, SmartArtOp } from "@filen/office/core/presentation"
import {
	SMARTART_COLORS,
	SMARTART_LAYOUTS,
	SMARTART_STYLES,
	type SmartArtDefinitionInfo,
	type SmartArtInfo
} from "@filen/office/core/smartart"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import {
	activeNodeIndex,
	addNodeOp,
	canInsertSmartArt,
	SmartArtPreviewCanvas,
	useSmartArtPreviews,
	newNodeId,
	nodeMoves,
	runSmartArtOp,
	smartArtPane,
	useSmartArtDiagram
} from "@/features/presentation/components/ribbon/insertSmartArt"
import type { PreviewKey } from "@/lib/i18n"

// The SmartArt Design tab, while one SmartArt graphic is selected: Create graphic (add a shape after, before, above
// or below the node chosen in the text pane, or the last one; promote, demote, move up and down, each off where the
// outline makes it impossible; the text pane), Layouts (our gallery's and the file's own), and SmartArt styles (style
// and colours: our gallery's and the file's own). The file's own definitions switch within this file only.

const BUTTON = 30
const MENU = 44
const LAYOUT_PREVIEW_PX = 56

type Kind = SmartArtDefinitionInfo["kind"]

const ADD_ITEMS: readonly { readonly position: "after" | "before" | "above" | "below"; readonly label: PreviewKey }[] = [
	{ position: "after", label: "previewPptxSmartArtAddAfter" },
	{ position: "before", label: "previewPptxSmartArtAddBefore" },
	{ position: "above", label: "previewPptxSmartArtAddAbove" },
	{ position: "below", label: "previewPptxSmartArtAddBelow" }
]

function refValue(def: SmartArtDefRef): string {
	return `${def.source}:${def.uniqueId}`
}

function refOf(value: string): SmartArtDefRef | undefined {
	const at = value.indexOf(":")
	const source = value.slice(0, at)

	return source === "gallery" || source === "deck" ? { source, uniqueId: value.slice(at + 1) } : undefined
}

// The definitions a picker lists: our gallery's, then the file's own (by kind), and the one the diagram names.
export function definitionChoices(
	info: SmartArtInfo | undefined,
	kind: Kind
): {
	readonly gallery: readonly { readonly uniqueId: string; readonly nameKey: string }[]
	readonly deck: readonly SmartArtDefinitionInfo[]
	readonly current: string | undefined
} {
	const gallery = kind === "layout" ? SMARTART_LAYOUTS : kind === "style" ? SMARTART_STYLES : SMARTART_COLORS
	const ours = new Set(gallery.map(entry => entry.uniqueId))
	const deck = (info?.deckDefinitions ?? []).filter(each => each.kind === kind && !ours.has(each.uniqueId))
	const named = info?.[kind]

	return {
		gallery,
		deck,
		current: named === undefined ? undefined : refValue({ uniqueId: named, source: ours.has(named) ? "gallery" : "deck" })
	}
}

function useDesign(editor: PresentationRibbonEditor) {
	const diagram = useSmartArtDiagram(editor)
	const index = activeNodeIndex(diagram.info, diagram.pane.node)

	return { ...diagram, index, moves: nodeMoves(diagram.info?.nodes ?? [], index) }
}

// ---- create graphic ----------------------------------------------------------------------------------------------

function CreateGraphicControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { target, info, index, moves, pane } = useDesign(editor)
	const focus = useCommandMenuFocus()
	const node = info?.nodes[index]
	const run = (op: SmartArtOp | undefined, chosen?: string): void => {
		if (op === undefined) return

		void runSmartArtOp(editor, op).then(ok => {
			if (ok && chosen !== undefined) smartArtPane.setNode(chosen)
		})
	}
	const nodeOp = (kind: "promote" | "demote"): SmartArtOp | undefined =>
		target === undefined || node === undefined ? undefined : { family: "smartart", kind, target, node: node.id }
	const move = (direction: "up" | "down"): SmartArtOp | undefined =>
		target === undefined || node === undefined ? undefined : { family: "smartart", kind: "moveNode", target, node: node.id, direction }
	const canAdd = (position: (typeof ADD_ITEMS)[number]["position"]): boolean =>
		target !== undefined && info !== undefined && addNodeOp(target, info, index, position, "") !== undefined

	return (
		<>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t("previewPptxSmartArtAddShape")}
					icon={<PlusIcon />}
					disabled={!ADD_ITEMS.some(item => canAdd(item.position))}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
				>
					{ADD_ITEMS.map(item => (
						<DropdownMenuItem
							key={item.position}
							disabled={!canAdd(item.position)}
							onClick={() => {
								focus.ran()

								if (target === undefined || info === undefined) return

								const id = newNodeId()

								run(addNodeOp(target, info, index, item.position, id), id)
							}}
						>
							{t(item.label)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<RibbonButton
				label={t("previewPptxSmartArtPromote")}
				icon={<IndentDecreaseIcon />}
				disabled={!moves.promote}
				onClick={() => {
					run(nodeOp("promote"))
				}}
			/>
			<RibbonButton
				label={t("previewPptxSmartArtDemote")}
				icon={<IndentIncreaseIcon />}
				disabled={!moves.demote}
				onClick={() => {
					run(nodeOp("demote"))
				}}
			/>
			<RibbonButton
				label={t("previewPptxSmartArtMoveUp")}
				icon={<ArrowUpIcon />}
				disabled={!moves.up}
				onClick={() => {
					run(move("up"))
				}}
			/>
			<RibbonButton
				label={t("previewPptxSmartArtMoveDown")}
				icon={<ArrowDownIcon />}
				disabled={!moves.down}
				onClick={() => {
					run(move("down"))
				}}
			/>
			<RibbonButton
				label={t("previewPptxSmartArtTextPane")}
				icon={<PanelLeftIcon />}
				pressed={pane.open}
				onClick={() => {
					smartArtPane.setOpen(!pane.open)
				}}
			/>
		</>
	)
}

// ---- layouts, styles, colours ------------------------------------------------------------------------------------

const DEF_OPS = { layout: "setLayout", style: "setStyle", colors: "setColors" } as const

function DefinitionMenu({
	editor,
	kind,
	label,
	icon
}: {
	editor: PresentationRibbonEditor
	kind: Kind
	label: PreviewKey
	icon: ReactNode
}) {
	const { t } = useTranslation("preview")
	const { target, info } = useSmartArtDiagram(editor)
	const { gallery, deck, current } = definitionChoices(info, kind)
	const choose = (value: string): void => {
		const def = refOf(value)

		if (def === undefined || target === undefined || value === current) return

		void runSmartArtOp(editor, { family: "smartart", kind: DEF_OPS[kind], target, def })
	}

	return (
		// A choice closes the menu (its entries go while the diagram is read again) and focus goes back to the trigger.
		<DropdownMenu>
			<RibbonMenuTrigger
				label={t(label)}
				icon={icon}
				disabled={info === undefined || gallery.length + deck.length === 0}
			/>
			<DropdownMenuContent
				data-preview-surface
				className="max-h-[60dvh] overflow-y-auto"
			>
				{info === undefined || target === undefined ? null : (
					<DefinitionItems
						editor={editor}
						kind={kind}
						gallery={gallery}
						deck={deck}
						current={current}
						onChoose={choose}
					/>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// The open menu's entries (mounted while it is open, so its layout previews live as long and no longer).
function DefinitionItems({
	editor,
	kind,
	gallery,
	deck,
	current,
	onChoose
}: {
	editor: PresentationRibbonEditor
	kind: Kind
	gallery: ReturnType<typeof definitionChoices>["gallery"]
	deck: ReturnType<typeof definitionChoices>["deck"]
	current: string | undefined
	onChoose: (value: string) => void
}) {
	const { t } = useTranslation("preview")
	const previews = useSmartArtPreviews(editor.session)
	const item = (def: SmartArtDefRef, label: string) => (
		<DropdownMenuRadioItem
			key={refValue(def)}
			value={refValue(def)}
			closeOnClick
		>
			{kind === "layout" ? (
				<SmartArtPreviewCanvas
					previews={previews}
					request={{ layout: def }}
					width={LAYOUT_PREVIEW_PX}
					className="shrink-0 border border-border"
				/>
			) : null}
			<span className="min-w-0 truncate">{label}</span>
		</DropdownMenuRadioItem>
	)

	return (
		<DropdownMenuRadioGroup
			value={current ?? ""}
			onValueChange={(value: string) => {
				onChoose(value)
			}}
		>
			{gallery.map(entry => item({ uniqueId: entry.uniqueId, source: "gallery" }, t(entry.nameKey as PreviewKey)))}
			{deck.length === 0 ? null : (
				<>
					{gallery.length === 0 ? null : <DropdownMenuSeparator />}
					<DropdownMenuGroup>
						<DropdownMenuLabel>{t("previewPptxSmartArtFromFile")}</DropdownMenuLabel>
						{deck.map(entry =>
							item(
								{ uniqueId: entry.uniqueId, source: "deck" },
								entry.title === "" ? t("previewPptxSmartArtUntitled", { id: entry.uniqueId }) : entry.title
							)
						)}
					</DropdownMenuGroup>
				</>
			)}
		</DropdownMenuRadioGroup>
	)
}

// ---- the groups --------------------------------------------------------------------------------------------------

export const smartartDesignGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable || !canInsertSmartArt(editor.info)) return []

	const t = context.t

	return [
		{
			id: "smartartCreate",
			label: t("previewPptxSmartArtCreateGraphic", { ns: "preview" }),
			icon: PlusIcon,
			width: MENU + 5 * BUTTON,
			priority: 4,
			content: <CreateGraphicControls editor={editor} />
		},
		{
			id: "smartartLayouts",
			label: t("previewPptxSmartArtLayouts", { ns: "preview" }),
			icon: LayoutGridIcon,
			width: MENU,
			priority: 3,
			single: true,
			content: (
				<DefinitionMenu
					editor={editor}
					kind="layout"
					label="previewPptxSmartArtChangeLayout"
					icon={<LayoutGridIcon />}
				/>
			)
		},
		{
			id: "smartartStyles",
			label: t("previewPptxSmartArtStyles", { ns: "preview" }),
			icon: SparklesIcon,
			width: 2 * MENU,
			priority: 2,
			content: (
				<>
					<DefinitionMenu
						editor={editor}
						kind="style"
						label="previewPptxSmartArtChangeStyle"
						icon={<SparklesIcon />}
					/>
					<DefinitionMenu
						editor={editor}
						kind="colors"
						label="previewPptxSmartArtChangeColors"
						icon={<PaletteIcon />}
					/>
				</>
			)
		}
	]
}
