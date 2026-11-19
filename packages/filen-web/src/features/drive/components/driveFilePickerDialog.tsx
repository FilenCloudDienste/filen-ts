import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { UseQueryResult } from "@tanstack/react-query"
import type { DriveItem } from "@/features/drive/lib/item"
import { driveItemName } from "@filen/shared"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { PICKER_ROW_CLASS, PickerBreadcrumb, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPicker } from "@/features/drive/hooks/useDirectoryPicker"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"

// Picking one file from the drive (chat attachments, a picture for a document): directories descend, a file
// row picks at once. Rows the caller does not accept are left out; undecryptable ones are disabled.

export interface DriveFilePickerListProps {
	listingQuery: UseQueryResult<DriveItem[]>
	rows: readonly DriveItem[]
	// The files offered (directories always are); every file when absent.
	accept?: ((file: DriveItem) => boolean) | undefined
	// The file being picked: a spinner on its row, every row disabled meanwhile.
	pending: string | null
	onDescend: (uuid: string) => void
	onPick: (file: DriveItem) => void
}

export function DriveFilePickerList({ listingQuery, rows, accept, pending, onDescend, onPick }: DriveFilePickerListProps) {
	const { t } = useTranslation("drive")
	const shown = accept === undefined ? rows : rows.filter(item => item.type === "directory" || accept(item))

	return (
		<PickerListShell
			listingQuery={listingQuery}
			filteredOutMessage={rows.length > 0 ? t("drivePickerNoMatchingFiles") : undefined}
			count={shown.length}
			rowKey={index => shown[index]?.data.uuid ?? String(index)}
			renderRow={index => {
				const item = shown[index]

				if (item === undefined) {
					return null
				}

				return (
					<button
						type="button"
						disabled={item.data.undecryptable || pending !== null}
						onClick={() => {
							if (item.type === "directory") {
								onDescend(item.data.uuid)
							} else if (!item.data.undecryptable) {
								onPick(item)
							}
						}}
						className={PICKER_ROW_CLASS}
					>
						<ItemIcon
							item={item}
							className="size-4 shrink-0"
						/>
						<span className="min-w-0 flex-1 truncate">{driveItemName(item)}</span>
						{pending === item.data.uuid ? <Spinner className="size-3.5 shrink-0" /> : null}
					</button>
				)
			}}
		/>
	)
}

export interface DriveFilePickerDialogProps {
	title: string
	description: string
	accept?: (file: DriveItem) => boolean
	// Takes the picked file; `signal` aborts when the dialog closes before it is done. The caller closes the
	// dialog once it is (onClose is for the user closing it).
	onPick: (file: DriveItem, signal: AbortSignal) => Promise<void>
	onClose: () => void
}

// Closing it while a pick is under way cancels that pick.
export function DriveFilePickerDialog({ title, description, accept, onPick, onClose }: DriveFilePickerDialogProps) {
	const { pathStack, listingQuery, items, namesQuery, descend, goRoot, goTo } = useDirectoryPicker()
	const [pending, setPending] = useState<string | null>(null)
	const pickRef = useRef<AbortController | null>(null)

	useEffect(
		() => () => {
			pickRef.current?.abort()
		},
		[]
	)

	const pick = (file: DriveItem): void => {
		const controller = new AbortController()

		pickRef.current = controller
		setPending(file.data.uuid)

		void onPick(file, controller.signal).finally(() => {
			if (pickRef.current === controller) {
				pickRef.current = null
				setPending(null)
			}
		})
	}

	return (
		<Dialog
			open
			onOpenChange={open => {
				if (!open) {
					pickRef.current?.abort()
					onClose()
				}
			}}
		>
			<DialogContent className={LIST_DIALOG_CLASS}>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<PickerBreadcrumb
					pathStack={pathStack}
					names={namesQuery.data}
					onRoot={goRoot}
					onJump={goTo}
				/>
				<DriveFilePickerList
					listingQuery={listingQuery}
					rows={items}
					accept={accept}
					pending={pending}
					onDescend={descend}
					onPick={pick}
				/>
			</DialogContent>
		</Dialog>
	)
}
