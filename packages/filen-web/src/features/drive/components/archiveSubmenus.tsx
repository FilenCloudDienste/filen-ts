import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { FileArchiveIcon, FolderPlusIcon, FolderSearchIcon, ListTreeIcon, PackageOpenIcon, SlidersHorizontalIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { PRESET_FORMATS, type PresetFormat } from "@/features/drive/lib/archiveFormats"
import { extractHereDestination } from "@/features/drive/lib/archiveTargets"
import { compressWithPreset, extractQuick, type ExtractHow } from "@/features/drive/lib/archiveActions"
import { cachedDirectoryName } from "@/features/drive/queries/drive"
import { useArchiveNameInfo } from "@/features/drive/hooks/useArchiveNameInfo"
import {
	DirectoryTreeSubmenu,
	type DirectoryTreeMenuFamily,
	type DirectoryTreeTarget
} from "@/features/drive/components/directoryTreeSubmenu"
import { Spinner } from "@/components/ui/spinner"
import { useIsOnline } from "@/lib/useIsOnline"
import { type ActionDef } from "@/lib/actionDescriptor"
import { type ArchiveKey, type DriveKey } from "@/lib/i18n"

// Compress and Extract as submenus of the item menus, the bulk context menu and (entries only, see
// BulkActionMenuButton) the selection bar. Their content mounts only while open (Base UI portals), so
// a closed menu costs nothing; Compress never reaches the worker before a click, Extract asks once for
// the archive name's format and default directory name (useArchiveNameInfo, remembered across opens).

const PRESET_LABEL_KEYS = {
	zip: "archiveCompressPresetZip",
	"7z": "archiveCompressPresetSevenZ",
	"tar.gz": "archiveCompressPresetTarGz"
} as const satisfies Record<PresetFormat, ArchiveKey>

// A directory name per uuid, read once per open menu: a bulk selection mostly shares one parent, and
// each read scans the cached listings.
function memoizedNameOf(): (uuid: string) => string | undefined {
	const names = new Map<string, string | undefined>()

	return uuid => {
		if (!names.has(uuid)) {
			names.set(uuid, cachedDirectoryName(uuid))
		}

		return names.get(uuid)
	}
}

// The picked directory's name for the job's card, from the listing its tree level was built from.
function treeDestination(target: DirectoryTreeTarget, rootName: string): ExtractHow {
	return {
		type: "to",
		destination: { uuid: target.uuid, name: target.uuid === null ? rootName : (cachedDirectoryName(target.uuid) ?? "") }
	}
}

interface SubmenuTriggerProps {
	family: DirectoryTreeMenuFamily
	// Offline: the submenu can't open; every entry needs the network.
	disabled: boolean
}

function ArchiveSubmenu({ family, disabled, def, children }: SubmenuTriggerProps & { def: ActionDef<DriveKey>; children: ReactNode }) {
	const { t } = useTranslation(["drive", "common"])
	const { Sub, SubTrigger, SubContent } = family

	return (
		<Sub>
			<SubTrigger
				disabled={disabled}
				title={disabled ? t("common:offlineActionDisabled") : undefined}
			>
				<def.icon aria-hidden="true" />
				{t(def.labelKey)}
			</SubTrigger>
			<SubContent className="max-w-72">{children}</SubContent>
		</Sub>
	)
}

export interface CompressMenuEntriesProps {
	family: DirectoryTreeMenuFamily
	items: DriveItem[]
	variant: DriveVariant
	// Opens the options dialog on the same items.
	onMoreOptions: () => void
}

// The presets (last-used options per format, never a password or a disposal) and the options dialog,
// which is only a form and opens offline too.
export function CompressMenuEntries({ family, items, variant, onMoreOptions }: CompressMenuEntriesProps) {
	const { t } = useTranslation(["archive", "common"])
	const isOnline = useIsOnline()
	const { Item, Separator } = family

	return (
		<>
			{PRESET_FORMATS.map(preset => (
				<Item
					key={preset}
					disabled={!isOnline}
					title={!isOnline ? t("common:offlineActionDisabled") : undefined}
					onClick={() => {
						void compressWithPreset(items, variant, preset)
					}}
				>
					<FileArchiveIcon aria-hidden="true" />
					{t(PRESET_LABEL_KEYS[preset])}
				</Item>
			))}
			<Separator />
			<Item onClick={onMoreOptions}>
				<SlidersHorizontalIcon aria-hidden="true" />
				{t("archiveCompressMoreOptions")}
			</Item>
		</>
	)
}

export function CompressSubmenu({ family, disabled, ...entries }: CompressMenuEntriesProps & SubmenuTriggerProps) {
	return (
		<ArchiveSubmenu
			family={family}
			disabled={disabled}
			def={ACTION_DEFS.compress}
		>
			<CompressMenuEntries
				family={family}
				{...entries}
			/>
		</ArchiveSubmenu>
	)
}

// "Extract to ▸": the Cloud Drive tree, every level offering "Extract here" for its own directory.
function ExtractToTree({ family, items, variant }: { family: DirectoryTreeMenuFamily; items: DriveItem[]; variant: DriveVariant }) {
	const { t } = useTranslation(["archive", "drive"])
	const isOnline = useIsOnline()

	return (
		<DirectoryTreeSubmenu
			family={family}
			label={t("archiveExtractTo")}
			icon={ACTION_DEFS.extract.icon}
			actionLabel={t("archiveExtractHere")}
			actionIcon={ACTION_DEFS.extract.icon}
			isBrowseDisabled={() => !isOnline}
			isTargetDisabled={() => !isOnline}
			onSelect={target => {
				void extractQuick(items, variant, treeDestination(target, t("drive:driveMyDrive")))
			}}
		/>
	)
}

export interface ExtractSubmenuProps extends SubmenuTriggerProps {
	item: DriveItem
	variant: DriveVariant
	// The destination picker (extractDestinationDialog.tsx) on this archive.
	onChooseDestination: () => void
	// The options dialog (extractDialog.tsx) on this archive.
	onOptions: () => void
	// The archive browser; the entry exists only where a surface can open it.
	onBrowse?: (() => void) | undefined
}

function ExtractMenuEntries({ family, item, variant, onChooseDestination, onOptions, onBrowse }: Omit<ExtractSubmenuProps, "disabled">) {
	const { t } = useTranslation(["archive", "drive"])
	const isOnline = useIsOnline()
	const info = useArchiveNameInfo(driveItemName(item))
	const { Item, Separator } = family
	// Null in Shared with me and wherever the archive's directory isn't known: no "here" entries then.
	const here = extractHereDestination(variant, item, t("drive:driveMyDrive"), cachedDirectoryName)
	const single = info.data?.format?.type === "single"
	// The labels need the name's answer, which takes a worker round trip on a first open.
	const resolving = info.status === "pending"
	const hereDisabled = info.status !== "success" || !isOnline

	return (
		<>
			{here !== null && !single ? (
				<Item
					disabled={hereDisabled}
					onClick={() => {
						void extractQuick([item], variant, { type: "hereNewFolder" })
					}}
				>
					{resolving ? <Spinner aria-hidden="true" /> : <FolderPlusIcon aria-hidden="true" />}
					<span className="min-w-0 flex-1 truncate">
						{t("archiveExtractHereNewFolder", { name: info.data?.defaultName ?? "…" })}
					</span>
				</Item>
			) : null}
			{here !== null ? (
				<Item
					disabled={hereDisabled}
					onClick={() => {
						void extractQuick([item], variant, { type: "here" })
					}}
				>
					{resolving ? <Spinner aria-hidden="true" /> : <PackageOpenIcon aria-hidden="true" />}
					<span className="min-w-0 flex-1 truncate">
						{single ? t("archiveExtractHereSingle", { name: info.data?.defaultName ?? "" }) : t("archiveExtractHere")}
					</span>
				</Item>
			) : null}
			<ExtractToTree
				family={family}
				items={[item]}
				variant={variant}
			/>
			<Item
				disabled={!isOnline}
				onClick={onChooseDestination}
			>
				<FolderSearchIcon aria-hidden="true" />
				{t("archiveExtractChooseDestination")}
			</Item>
			<Separator />
			<Item onClick={onOptions}>
				<SlidersHorizontalIcon aria-hidden="true" />
				{t("archiveExtractWithOptions")}
			</Item>
			{onBrowse !== undefined ? (
				<Item onClick={onBrowse}>
					<ListTreeIcon aria-hidden="true" />
					{t("archiveBrowseContents")}
				</Item>
			) : null}
		</>
	)
}

export function ExtractSubmenu({ family, disabled, ...entries }: ExtractSubmenuProps) {
	return (
		<ArchiveSubmenu
			family={family}
			disabled={disabled}
			def={ACTION_DEFS.extract}
		>
			<ExtractMenuEntries
				family={family}
				{...entries}
			/>
		</ArchiveSubmenu>
	)
}

export interface BulkExtractMenuEntriesProps {
	family: DirectoryTreeMenuFamily
	// Every one an archive (DriveSelectionFlags.everyArchive); one queued job each.
	items: DriveItem[]
	variant: DriveVariant
	// The destination picker on the whole selection.
	onChooseDestination: () => void
}

export function BulkExtractMenuEntries({ family, items, variant, onChooseDestination }: BulkExtractMenuEntriesProps) {
	const { t } = useTranslation(["archive", "drive"])
	const isOnline = useIsOnline()
	const { Item } = family
	const rootName = t("drive:driveMyDrive")
	const nameOf = memoizedNameOf()
	let withHere = 0

	for (const item of items) {
		if (extractHereDestination(variant, item, rootName, nameOf) !== null) {
			withHere++
		}
	}

	return (
		<>
			{/* Absent where no archive has a "here" (Shared with me); greyed out while only some do. */}
			{withHere > 0 ? (
				<Item
					disabled={withHere < items.length || !isOnline}
					onClick={() => {
						void extractQuick(items, variant, { type: "hereNewFolder" })
					}}
				>
					<FolderPlusIcon aria-hidden="true" />
					{t("archiveExtractHereEach")}
				</Item>
			) : null}
			<ExtractToTree
				family={family}
				items={items}
				variant={variant}
			/>
			<Item
				disabled={!isOnline}
				onClick={onChooseDestination}
			>
				<FolderSearchIcon aria-hidden="true" />
				{t("archiveExtractChooseDestination")}
			</Item>
		</>
	)
}

export function BulkExtractSubmenu({ family, disabled, ...entries }: BulkExtractMenuEntriesProps & SubmenuTriggerProps) {
	return (
		<ArchiveSubmenu
			family={family}
			disabled={disabled}
			def={ACTION_DEFS.extract}
		>
			<BulkExtractMenuEntries
				family={family}
				{...entries}
			/>
		</ArchiveSubmenu>
	)
}
