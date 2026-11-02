import { showOptionsOf, type PresentationDocument, type PresentationStore } from "@filen/office/react/presentation"
import { SetUpShowDialog } from "@/features/presentation/components/slideshow/setUpDialog"
import { showSettingsOf } from "@/features/presentation/components/slideshow/setUpDialog.logic"
import { setSetUpOpen, setShowOptions, useChosenShowOptions, useSetUpOpen } from "@/features/presentation/components/slideshow/showSettings"
import { useRibbonFocusRecording } from "@/features/presentation/components/ribbon/ribbonDialogs"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"

// Set Up Slide Show as the deck's show layer holds it (the Slide Show tab only asks for it). In an editable deck the
// settings are saved in the file (one undoable op); a deck that can only be viewed, or a refused change (told by the
// editor), keeps them for this session.
export function SetUpShowHost({ store, deck }: { store: PresentationStore; deck: PresentationDocument }) {
	const open = useSetUpOpen(store)
	const chosen = useChosenShowOptions(store)
	const editor = usePresentationEditor()?.editor
	const saved = editor?.editable === true

	// The ribbon's command that opens it (and starts a show) is recorded, for focus to go back to it.
	useRibbonFocusRecording()

	return (
		<SetUpShowDialog
			open={open}
			saved={saved}
			odf={saved && deck.info?.format === "odp"}
			options={chosen ?? showOptionsOf(deck.info?.show)}
			slideCount={deck.slides.length}
			customShows={deck.info?.customShows ?? []}
			onApply={options => {
				if (editor === undefined || !saved) {
					setShowOptions(store, options)

					return
				}

				void editor
					.command({ family: "presentation", kind: "setShow", show: showSettingsOf(options, deck.info?.show) })
					.then(result => {
						setShowOptions(store, result.ok ? undefined : options)
					})
			}}
			onClose={() => {
				setSetUpOpen(store, false)
			}}
		/>
	)
}
