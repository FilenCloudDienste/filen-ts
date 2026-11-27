import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { driveItemName, extensionOf, nameCollisionKey } from "@filen/shared"
import { useDebouncedValue } from "@/lib/useDebouncedValue"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { ITEM_NAME_ERROR_KEYS } from "@/features/drive/lib/archiveTargets"
import { claimParent } from "@/features/drive/lib/uploadClaims"
import { driveListingQueryOptions } from "@/features/drive/queries/drive"
import { NAME_CHECK_DEBOUNCE_MS, useItemNameError } from "@/features/drive/hooks/useItemNameError"

// Which item of `items` (a directory's listing) holds `name`, the item `selfUuid` aside (a rename may change only
// the case of its own name).
export function nameHolder(items: readonly DriveItem[] | undefined, name: string, selfUuid?: string): DriveItem | undefined {
	if (items === undefined || name.length === 0) {
		return undefined
	}

	const key = nameCollisionKey(name)

	return items.find(item => item.data.uuid !== selfUuid && nameCollisionKey(driveItemName(item)) === key)
}

// "photo.JPG" to "photo.jpg" changes no type; "notes.txt" to "notes.md" or "notes" does.
export function extensionChange(from: string, to: string): { from: string; to: string } | null {
	const before = extensionOf(from)
	const after = extensionOf(to)

	return before === after ? null : { from: before, to: after }
}

export interface NameFieldCheck {
	// Why the name can't be submitted, null when it can (as far as is known yet).
	error: string | null
	// Whether `name` is known to be refused: taken, or refused by the SDK.
	blocked: (name: string) => boolean
	// Said under the field without blocking the submit.
	warning: string | null
}

// The inline checks of a name typed for an item in `parentUuid` (the rename and New directory dialogs): the names its
// listing holds, read from the cache without a request (unfiltered: a hidden item holds its name too) and checked at
// once; and the SDK's own name rules, asked once typing pauses (useItemNameError). `self`: the item being renamed,
// whose extension change is warned about.
export function useNameFieldCheck({
	parentUuid,
	name,
	self
}: {
	parentUuid: string | null
	name: string
	self?: DriveItem
}): NameFieldCheck {
	const { t } = useTranslation(["drive", "archive"])
	const listing = useQuery({ ...driveListingQueryOptions("drive", claimParent(parentUuid)), enabled: false })
	const trimmed = name.trim()
	const checked = useDebouncedValue(trimmed, NAME_CHECK_DEBOUNCE_MS)
	const nameError = useItemNameError(checked, checked.length > 0)
	const selfUuid = self?.data.uuid
	const unchanged = self !== undefined && trimmed === driveItemName(self)

	function holderOf(value: string): DriveItem | undefined {
		return unchanged ? undefined : nameHolder(listing.data, value.trim(), selfUuid)
	}

	const holder = holderOf(trimmed)
	const sdkError = !unchanged && checked === trimmed && nameError.data !== undefined ? nameError.data : null
	const error =
		holder !== undefined
			? t(isDirectoryItem(holder) ? "driveNameTakenByDirectory" : "driveNameTakenByFile")
			: sdkError !== null
				? t(`archive:${ITEM_NAME_ERROR_KEYS[sdkError]}`)
				: null
	const change = self !== undefined && !isDirectoryItem(self) && trimmed.length > 0 ? extensionChange(driveItemName(self), trimmed) : null
	const none = t("driveRenameExtensionNone")

	return {
		error,
		blocked: value => holderOf(value) !== undefined || (value.trim() === trimmed && sdkError !== null),
		warning:
			change === null || error !== null
				? null
				: t("driveRenameExtensionChange", {
						from: change.from === "" ? none : `.${change.from}`,
						to: change.to === "" ? none : `.${change.to}`
					})
	}
}
