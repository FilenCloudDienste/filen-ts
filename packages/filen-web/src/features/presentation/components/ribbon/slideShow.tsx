import { useTranslation } from "react-i18next"
import { ListVideoIcon, MonitorPlayIcon, PlayIcon, PresentationIcon, Settings2Icon, StepForwardIcon } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"
import { setSetUpOpen } from "@/features/presentation/components/slideshow/showSettings"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"

// The presentation ribbon's Slide Show tab: start the show from the beginning, from the slide in view, as one of the
// deck's custom shows or with the presenter view; Set Up Slide Show. Offered in a deck that can only be viewed too.

// Widths with their gaps, as the browsers lay the labelled buttons out (ribbonFit's estimates).
const FROM_BEGINNING = 124
const FROM_CURRENT = 150
const CUSTOM = 166
const PRESENTER = 132
const SET_UP = 150

function StartButtons() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	const { view, editor } = scope
	const empty = editor.document.slides.length === 0
	const customShows = editor.document.info?.customShows ?? []

	return (
		<>
			<RibbonButton
				label={t("previewPptxShowFromBeginning")}
				text={t("previewPptxShowFromBeginning")}
				icon={<PlayIcon />}
				disabled={empty}
				onClick={() => {
					view.startShowFrom()
				}}
			/>
			<RibbonButton
				label={t("previewPptxShowFromCurrent")}
				text={t("previewPptxShowFromCurrent")}
				icon={<StepForwardIcon />}
				disabled={empty}
				onClick={() => {
					view.startShowFrom({ index: editor.current })
				}}
			/>
			<DropdownMenu>
				<RibbonMenuTrigger
					label={t("previewPptxShowCustom")}
					text={t("previewPptxShowCustom")}
					icon={<ListVideoIcon />}
					disabled={empty}
				/>
				<DropdownMenuContent data-preview-surface>
					{customShows.length === 0 ? (
						<DropdownMenuGroup>
							<DropdownMenuLabel className="font-normal text-muted-foreground">
								{t("previewPptxShowCustomNone")}
							</DropdownMenuLabel>
						</DropdownMenuGroup>
					) : (
						customShows.map(show => (
							<DropdownMenuItem
								key={show.id}
								onClick={() => {
									view.startShowFrom({ customShow: show.id })
								}}
							>
								{show.name}
							</DropdownMenuItem>
						))
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{view.startPresenter === undefined ? null : (
				<RibbonButton
					label={t("previewPptxShowPresenterView")}
					text={t("previewPptxShowPresenterView")}
					icon={<PresentationIcon />}
					disabled={empty}
					onClick={() => {
						view.startPresenter?.({ index: editor.current })
					}}
				/>
			)}
		</>
	)
}

function SetUpButton() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	const { store } = scope.editor

	return (
		<RibbonButton
			label={t("previewPptxShowSetUp")}
			text={t("previewPptxShowSetUp")}
			icon={<Settings2Icon />}
			onClick={() => {
				setSetUpOpen(store, true)
			}}
		/>
	)
}

export const slideShowGroups: PresentationGroups = context => [
	{
		id: "start",
		label: context.t("previewPptxShowStartGroup", { ns: "preview" }),
		icon: MonitorPlayIcon,
		width: FROM_BEGINNING + FROM_CURRENT + CUSTOM + PRESENTER,
		priority: 8,
		content: <StartButtons />
	},
	{
		id: "setUp",
		label: context.t("previewPptxShowSetUpGroup", { ns: "preview" }),
		icon: Settings2Icon,
		width: SET_UP,
		priority: 4,
		single: true,
		content: <SetUpButton />
	}
]
