import { toast } from "sonner"
import { onlineManager } from "@tanstack/react-query"
import { driveItemName, type JobDestination } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { cachedDirectoryName } from "@/features/drive/queries/drive"
import type { ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"
import { archiveFormatInfo, archiveNameInfo, cachedArchiveNameInfo } from "@/features/drive/lib/archiveHelpers"
import {
	buildCompressFormat,
	effectiveLevel,
	formatChoice,
	isFormatRunnable,
	probeFormat,
	type FormatOptions,
	type PresetFormat
} from "@/features/drive/lib/archiveFormats"
import { loadCompressPreferences, presetOptions } from "@/features/drive/lib/compressPreferences"
import {
	archiveParentName,
	composeArchiveName,
	defaultArchiveBaseName,
	defaultJobDestination,
	extractHereDestination,
	extractRequest,
	namingEntries,
	type ParentNaming
} from "@/features/drive/lib/archiveTargets"
import { startCompressWithCard, startExtractBatchWithCards, startExtractWithCard } from "@/features/transfers/lib/archiveToast"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { fullExtractRequest } from "@/features/archive/lib/extractSelection"

// The Compress and Extract submenus' one-click entries: the only path from a menu to a job. Nothing
// here runs before the click; preferences and format answers are memoised for the page.

// The menus gate their entries offline too; a job is never started without the network.
function refuseOffline(): boolean {
	if (onlineManager.isOnline()) {
		return false
	}

	toast.error(i18n.t("common:offlineActionDisabled"))

	return true
}

function presetMethod(
	preset: PresetFormat,
	options: FormatOptions
): FormatOptions["zipMethod"] | FormatOptions["sevenZMethod"] | undefined {
	switch (preset) {
		case "zip":
			return options.zipMethod
		case "7z":
			return options.sevenZMethod
		default:
			return undefined
	}
}

// Never a password, never removes the originals. A format whose lowest level needs more codec memory
// than the setting allows is not started: the toast says where to raise it.
export async function compressWithPreset(
	items: DriveItem[],
	variant: DriveVariant,
	preset: PresetFormat,
	parentNaming?: ParentNaming
): Promise<void> {
	if (refuseOffline()) {
		return
	}

	try {
		const options = presetOptions(await loadCompressPreferences(), preset)
		const info = await archiveFormatInfo(probeFormat(preset, presetMethod(preset, options)))

		if (!isFormatRunnable(info)) {
			toast.error(i18n.t("archive:archiveFormatNeedsMemoryToast", { format: i18n.t(`archive:${formatChoice(preset).labelKey}`) }))

			return
		}

		const nameOf = parentNaming?.nameOf ?? cachedDirectoryName
		const base = defaultArchiveBaseName(
			namingEntries(items),
			preset,
			archiveParentName(items, nameOf, parentNaming?.mixedFallback),
			i18n.t("archive:archiveDefaultName")
		)

		startCompressWithCard(
			{
				source: { kind: "items", items },
				destination: defaultJobDestination(items, variant, i18n.t("drive:driveMyDrive"), nameOf),
				name: composeArchiveName(base, info.extension),
				format: buildCompressFormat(preset, { ...options, level: effectiveLevel(info, options.level) }, false),
				encrypted: false,
				dispose: null,
				itemCount: items.length
			},
			undefined
		)
	} catch (error) {
		toast.error(errorLabel(error))
	}
}

export type ExtractHow = { type: "hereNewFolder" } | { type: "here" } | { type: "to"; destination: JobDestination }

// Several archives each go into a new directory of their own, whatever `how`; one queued job each.
// "here" starts nothing unless every archive has a directory of its own to go to: none in Shared with
// me, where the menus offer no "here". A single compressed file by its name asks for a new directory
// even "here": the SDK ignores it for a real one, and a tarball named like one stays together.
export async function extractQuick(items: DriveItem[], variant: DriveVariant, how: ExtractHow): Promise<void> {
	if (refuseOffline()) {
		return
	}

	try {
		const infos = await Promise.all(items.map(item => archiveNameInfo(driveItemName(item))))
		const rootName = i18n.t("drive:driveMyDrive")
		const requests: Omit<ExtractJobRequest, "id">[] = []

		for (const [index, item] of items.entries()) {
			const info = infos[index]
			const destination = how.type === "to" ? how.destination : extractHereDestination(variant, item, rootName, cachedDirectoryName)

			if (info === undefined || destination === null) {
				return
			}

			const root = how.type === "here" && items.length === 1 && info.format?.type !== "single" ? "destination" : "newFolder"

			requests.push(extractRequest(item, info, destination, { root }))
		}

		const [only] = requests

		if (requests.length === 1 && only !== undefined) {
			startExtractWithCard(only, undefined)
		} else if (requests.length > 1) {
			startExtractBatchWithCards(requests)
		}
	} catch (error) {
		toast.error(errorLabel(error))
	}
}

// The whole archive into a new directory in `destination`, named by the SDK after it: any readable
// archive (a public link's, a chat's), never removed afterwards.
export async function extractArchiveTo(source: ArchiveSource, destination: JobDestination): Promise<void> {
	if (refuseOffline()) {
		return
	}

	try {
		const info = cachedArchiveNameInfo(source.name) ?? (await archiveNameInfo(source.name))

		startExtractWithCard(
			fullExtractRequest({ source, info, summary: null, target: { type: "directory", destination }, destination }),
			undefined
		)
	} catch (error) {
		toast.error(errorLabel(error))
	}
}
