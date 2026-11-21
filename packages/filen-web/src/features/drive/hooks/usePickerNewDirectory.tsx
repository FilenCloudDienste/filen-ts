import { useState, type ReactNode } from "react"
import { createDirectory } from "@/features/drive/lib/actions"
import { itemNameError } from "@/features/drive/lib/archiveHelpers"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DirectoryPicker } from "@/features/drive/hooks/useDirectoryPicker"
import type { PickerLeading } from "@/features/drive/components/directoryPicker"
import {
	PICKER_NEW_DIRECTORY_ERROR_HEIGHT,
	PICKER_NEW_DIRECTORY_HEIGHT,
	PickerNewDirectoryButton,
	PickerNewDirectoryRow
} from "@/features/drive/components/pickerNewDirectory"
import {
	cancelsOnBlur,
	localDraftError,
	type PickerNewDirectoryDraft,
	type PickerNewDirectoryError
} from "@/features/drive/lib/pickerNewDirectory.logic"

export interface UsePickerNewDirectoryParams {
	picker: Pick<DirectoryPicker, "pathStack" | "targetUuid" | "listingQuery" | "enter">
	// Whether this picker offers a new directory where it is: false where nothing created there could be picked.
	available: boolean
	// The host's own work is under way.
	disabled: boolean
}

export interface PickerNewDirectory {
	// For the dialog's footer, before its buttons; null where it is not offered.
	button: ReactNode
	// The name row for the listing, while one is open.
	leading: PickerLeading | undefined
	// A create is under way: the host's confirm would pick its parent instead.
	pending: boolean
}

type SubmitResult = { ok: true; uuid: string } | { ok: false; error: PickerNewDirectoryError }

// The listing's answer first, then the SDK's own name rules (memoised, no request), then the create, which patches
// the "drive" listing it lands in, so the drive shows it too without a refetch.
async function submitName({
	parentUuid,
	name,
	listing
}: {
	parentUuid: string | null
	name: string
	listing: readonly DriveItem[]
}): Promise<SubmitResult> {
	const local = localDraftError(name, listing)

	if (local !== null) {
		return { ok: false, error: local }
	}

	const trimmed = name.trim()
	const reason = await itemNameError(trimmed).catch((e: unknown) => new Error(errorLabel(e)))

	if (reason instanceof Error) {
		return { ok: false, error: { kind: "failed", message: reason.message } }
	}

	if (reason !== null) {
		return { ok: false, error: { kind: "name", reason } }
	}

	const outcome = await createDirectory(parentUuid, trimmed)

	return outcome.status === "error"
		? { ok: false, error: { kind: "failed", message: errorLabel(outcome.dto) } }
		: { ok: true, uuid: outcome.item.data.uuid }
}

// "New directory" for the in-dialog drive pickers: a footer button that opens a name row over the listing; Enter
// creates the directory in the one open and opens it, so the picker's confirm targets it. Hidden offline and where
// the host says nothing created could be picked. A path change drops an open row (react.dev's "adjusting state when
// a prop changes", in render); a create answering after the user browsed away opens nothing.
export function usePickerNewDirectory({ picker, available, disabled }: UsePickerNewDirectoryParams): PickerNewDirectory {
	const isOnline = useIsOnline()
	const { pathStack, targetUuid, listingQuery, enter } = picker
	const [draft, setDraft] = useState<PickerNewDirectoryDraft | null>(null)
	const pathKey = pathStack.join("/")
	const [draftPathKey, setDraftPathKey] = useState(pathKey)

	if (pathKey !== draftPathKey) {
		setDraftPathKey(pathKey)
		setDraft(null)
	}

	const offered = available && isOnline
	const shown = offered && draft !== null && draft.parentUuid === targetUuid ? draft : null

	async function submit(current: PickerNewDirectoryDraft): Promise<void> {
		if (current.pending || listingQuery.data === undefined) {
			return
		}

		const parentUuid = current.parentUuid

		setDraft({ ...current, pending: true, error: null })

		const result = await submitName({ parentUuid, name: current.name, listing: listingQuery.data })

		if (result.ok) {
			setDraft(prev => (prev?.parentUuid === parentUuid ? null : prev))
			enter(parentUuid, result.uuid)

			return
		}

		setDraft(prev => (prev?.parentUuid === parentUuid && prev.pending ? { ...prev, pending: false, error: result.error } : prev))
	}

	return {
		button: offered ? (
			<PickerNewDirectoryButton
				disabled={disabled || shown?.pending === true || listingQuery.status !== "success"}
				onClick={() => {
					setDraft({ parentUuid: targetUuid, name: "", pending: false, error: null })
				}}
			/>
		) : null,
		leading:
			shown === null
				? undefined
				: {
						height: PICKER_NEW_DIRECTORY_HEIGHT + (shown.error === null ? 0 : PICKER_NEW_DIRECTORY_ERROR_HEIGHT),
						node: (
							<PickerNewDirectoryRow
								draft={shown}
								onChange={name => {
									setDraft({ ...shown, name, error: null })
								}}
								onSubmit={() => {
									void submit(shown)
								}}
								onCancel={() => {
									setDraft(null)
								}}
								onBlur={() => {
									if (cancelsOnBlur(shown)) {
										setDraft(null)
									}
								}}
							/>
						)
					},
		pending: shown?.pending === true
	}
}
