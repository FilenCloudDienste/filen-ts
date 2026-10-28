import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CopyIcon } from "lucide-react"
import type { GateReason } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu"
import { DownloadAsItemProvider, EditorDownloadAsItems, type LivePresentation } from "@/features/drive/components/editorDownloadAs"
import { downloadAsTargets } from "@/features/drive/lib/downloadAs.logic"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PresentationFileMenuEntryProps } from "@/features/presentation/components/fileMenu/save"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import { readFreshPackage, saveConvertedCopy } from "@/features/presentation/lib/presentationConvert"
import { usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { useIsOnline } from "@/lib/useIsOnline"

// Download as another format: the formats the open deck converts to (an .odp of a PowerPoint deck, a .pptx of an
// OpenDocument one, either of a 97–2003 one), written from its session so unsaved changes are in it, and downloaded
// under the file's name (the item menus' Download as, lib/downloadAs.ts); offered only where the file may be
// downloaded. A deck this editor only views for what it is (Strict Open XML, signed, protected from changes) also
// offers Save a copy as .pptx where a copy may be saved beside it: a Transitional copy (sealed with the deck's password
// when it has one), whose differences the deck's surface then lists, with the copy opened from there.

// The gates a Transitional copy lifts (a damaged deck's copy would carry the damage).
const COPY_GATES: ReadonlySet<GateReason> = new Set(["strict", "signed", "writeProtected"])

// Decks whose copy is being saved (a second pick while one is would save two).
const savingCopies = new WeakSet<PresentationSessionApi>()

function DownloadAsMenu({ item, live }: { item: DriveItem; live: LivePresentation }) {
	const { t } = useTranslation("preview")
	const downloadable = usePreviewDownloadable()
	const conversions = downloadAsTargets([item])
		.flat()
		.filter(target => target !== "pdf")

	if (!downloadable || conversions.length === 0) return null

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>{t("previewPptxConvertDownloadAs")}</DropdownMenuSubTrigger>
			<DropdownMenuSubContent data-preview-surface>
				<EditorDownloadAsItems
					first
					livePresentation={live}
				/>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	)
}

// Download as for a deck only viewed (a public link's, a shared file's): its session's conversions, nothing to flush.
export function PresentationDownloadAsMenu({ item, session }: { item: DriveItem; session: PresentationSessionApi }): ReactNode {
	return (
		<DownloadAsItemProvider item={item}>
			<DownloadAsMenu
				item={item}
				live={(target, signal) => readFreshPackage(session, target, signal)}
			/>
		</DownloadAsItemProvider>
	)
}

export function PresentationDownloadAsEntries({ context }: PresentationFileMenuEntryProps): ReactNode {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const online = useIsOnline()
	const { item, session, saveCopy } = context

	if (item === undefined || session === undefined) return null

	const gate = scope?.editor.document.info?.gate ?? []
	const copyable = saveCopy !== undefined && context.format === "pptx" && gate.some(reason => COPY_GATES.has(reason))

	return (
		<>
			{context.downloads ? (
				<DownloadAsItemProvider item={item}>
					<DownloadAsMenu
						item={item}
						live={async (target, signal) => {
							// The body being typed in goes to the deck first, as Save sends it.
							await context.text?.flush()

							return readFreshPackage(session, target, signal)
						}}
					/>
				</DownloadAsItemProvider>
			) : null}
			{copyable ? (
				<DropdownMenuItem
					disabled={!online}
					onClick={() => {
						if (savingCopies.has(session)) return

						savingCopies.add(session)

						const id = toast.loading(t("previewPptxConvertSavingCopy"))

						void saveConvertedCopy(saveCopy, "pptx", { always: true, failedKey: "previewPptxConvertSaveCopyFailed" }).finally(
							() => {
								savingCopies.delete(session)
								toast.dismiss(id)
							}
						)
					}}
				>
					<CopyIcon />
					{t("previewPptxConvertSaveCopy")}
				</DropdownMenuItem>
			) : null}
		</>
	)
}
