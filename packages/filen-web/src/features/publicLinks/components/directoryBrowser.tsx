import { useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/utils"
import { ChevronRightIcon, DownloadIcon, SearchIcon, ArrowDownAZIcon, ArrowUpAZIcon } from "lucide-react"
import type { DirPublicInfo, DirPublicLink, File as SdkFile } from "@filen/sdk-rs"
import { type DriveItem } from "@/features/drive/lib/item"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { formatItemSize, formatModifiedDate } from "@/features/drive/lib/format"
import { usePublicDirListing, usePublicDirSize } from "@/features/publicLinks/queries/publicLink"
import {
	rootCrumb,
	enterCrumb,
	jumpToCrumb,
	toBrowseEntries,
	filterEntries,
	sortEntries,
	entryName,
	DEFAULT_PUBLIC_SORT,
	type BrowseCrumb,
	type BrowseEntry,
	type PublicSortField
} from "@/features/publicLinks/lib/browse.logic"
import { startAnonDirZipDownload } from "@/features/publicLinks/lib/download"
import { FileHero } from "@/features/publicLinks/components/fileHero"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PublicLinkError } from "@/features/publicLinks/components/publicLinkStates"
import { cn } from "@/lib/utils"

type ZipUiState = { status: "idle" } | { status: "running"; loaded: number; total: number | null } | { status: "error" }

const SORT_FIELDS: PublicSortField[] = ["name", "size", "date"]

// The directory browse surface: a virtual navigation stack (breadcrumb clicks + folder taps mutate a
// client-side crumb array, the route/hash never change — old-web parity), a client-side filter/sort
// over the current level's already-fetched entries, and a flag-gated whole-directory zip download. A
// tapped file opens the shared FileHero in-place (same session, password carried) rather than hard-
// navigating to /f/ (which would need a per-file link that does not exist).
export function DirectoryBrowser({ info, link }: { info: DirPublicInfo; link: DirPublicLink }) {
	const { t } = useTranslation("publicLinks")
	const [stack, setStack] = useState<BrowseCrumb[]>(() => [rootCrumb(info)])
	const [selected, setSelected] = useState<{ item: DriveItem; file: SdkFile } | null>(null)
	const [filter, setFilter] = useState("")
	const [sort, setSort] = useState(DEFAULT_PUBLIC_SORT)
	const [zip, setZip] = useState<ZipUiState>({ status: "idle" })

	const current = stack[stack.length - 1] ?? rootCrumb(info)
	const listing = usePublicDirListing({ levelUuid: current.uuid, dir: current.dir, link })
	const sizeInfo = usePublicDirSize({ levelUuid: current.uuid, dir: current.dir, link })

	const entries = listing.data === undefined ? [] : sortEntries(filterEntries(toBrowseEntries(listing.data), filter), sort)

	function openEntry(entry: BrowseEntry): void {
		if (entry.kind === "dir") {
			setStack(prev => enterCrumb(prev, entry))
			setFilter("")
			setSelected(null)
		} else {
			setSelected({ item: entry.item, file: entry.file })
		}
	}

	function jumpTo(index: number): void {
		setStack(prev => jumpToCrumb(prev, index))
		setFilter("")
		setSelected(null)
	}

	function handleZip(): void {
		setZip({ status: "running", loaded: 0, total: null })

		void startAnonDirZipDownload({
			dir: { dir: current.dir, link },
			name: current.name,
			onProgress: (loaded, total) => {
				setZip(prev => (prev.status === "running" ? { status: "running", loaded, total } : prev))
			}
		}).then(outcome => {
			setZip(outcome.status === "error" ? { status: "error" } : { status: "idle" })
		})
	}

	// A tapped child file takes over the whole surface (it carries its own back bar); the browse chrome
	// returns when it is dismissed.
	if (selected !== null) {
		return (
			<FileHero
				item={selected.item}
				downloadEnabled={link.enableDownload}
				onBack={() => {
					setSelected(null)
				}}
			/>
		)
	}

	const summary =
		sizeInfo.data !== undefined
			? t("itemSummary", {
					count: Number(sizeInfo.data.files) + Number(sizeInfo.data.dirs),
					size: formatBytes(Number(sizeInfo.data.size))
				})
			: null

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-3 p-4 sm:p-6">
			<Breadcrumbs
				stack={stack}
				onJump={jumpTo}
			/>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col">
					<h1 className="truncate text-lg font-semibold">{current.name}</h1>
					{summary !== null && <p className="text-xs text-muted-foreground">{summary}</p>}
				</div>
				{link.enableDownload && (
					<Button
						variant="outline"
						size="sm"
						onClick={handleZip}
						disabled={zip.status === "running"}
					>
						{zip.status === "running" ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
						{zip.status === "running" ? t("preparingDownload") : t("downloadDirectory")}
					</Button>
				)}
			</div>

			{zip.status === "running" && (
				<Progress value={zip.total !== null && zip.total > 0 ? Math.round((zip.loaded / zip.total) * 100) : null} />
			)}

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-40 flex-1">
					<SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={filter}
						onChange={event => {
							setFilter(event.target.value)
						}}
						placeholder={t("filterPlaceholder")}
						className="pl-8"
					/>
				</div>
				<Select
					items={SORT_FIELDS.map(field => ({ value: field, label: t(sortFieldLabelKey(field)) }))}
					value={sort.field}
					onValueChange={value => {
						if (value !== null) {
							setSort(prev => ({ ...prev, field: value }))
						}
					}}
				>
					<SelectTrigger
						aria-label={t("sortLabel")}
						className="w-32"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{SORT_FIELDS.map(field => (
								<SelectItem
									key={field}
									value={field}
								>
									{t(sortFieldLabelKey(field))}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				<Button
					variant="outline"
					size="icon"
					aria-label={t("sortLabel")}
					onClick={() => {
						setSort(prev => ({ ...prev, direction: prev.direction === "asc" ? "desc" : "asc" }))
					}}
				>
					{sort.direction === "asc" ? <ArrowDownAZIcon /> : <ArrowUpAZIcon />}
				</Button>
			</div>

			<BrowseList
				listing={listing}
				entries={entries}
				filtered={filter.trim().length > 0}
				onOpen={openEntry}
			/>
		</div>
	)
}

function sortFieldLabelKey(field: PublicSortField): "sortName" | "sortSize" | "sortDate" {
	if (field === "size") {
		return "sortSize"
	}

	if (field === "date") {
		return "sortDate"
	}

	return "sortName"
}

function Breadcrumbs({ stack, onJump }: { stack: BrowseCrumb[]; onJump: (index: number) => void }) {
	return (
		<nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
			{stack.map((crumb, index) => {
				const isLast = index === stack.length - 1

				return (
					<span
						key={crumb.uuid}
						className="flex items-center gap-1"
					>
						{index > 0 && <ChevronRightIcon className="size-3.5 shrink-0" />}
						{isLast ? (
							<span className="max-w-[12rem] truncate font-medium text-foreground">{crumb.name}</span>
						) : (
							<button
								type="button"
								onClick={() => {
									onJump(index)
								}}
								className="max-w-[10rem] truncate rounded-md px-1 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							>
								{crumb.name}
							</button>
						)}
					</span>
				)
			})}
		</nav>
	)
}

function BrowseList({
	listing,
	entries,
	filtered,
	onOpen
}: {
	listing: ReturnType<typeof usePublicDirListing>
	entries: BrowseEntry[]
	filtered: boolean
	onOpen: (entry: BrowseEntry) => void
}) {
	const { t } = useTranslation("publicLinks")

	if (listing.status === "pending") {
		return (
			<div className="flex flex-col gap-1">
				{Array.from({ length: 8 }, (_, index) => (
					<div
						key={index}
						className="flex h-11 items-center gap-3 rounded-xl px-3"
					>
						<div className="size-5 shrink-0 animate-pulse rounded-md bg-muted" />
						<div className="h-3 flex-1 animate-pulse rounded-md bg-muted" />
					</div>
				))}
			</div>
		)
	}

	if (listing.status === "error") {
		return (
			<PublicLinkError
				onRetry={() => {
					void listing.refetch()
				}}
			/>
		)
	}

	if (entries.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center py-16 text-center text-sm text-muted-foreground">
				{filtered ? t("noMatches") : t("emptyDirectory")}
			</div>
		)
	}

	return (
		<div
			role="list"
			className="flex flex-col"
		>
			{entries.map(entry => (
				<BrowseRow
					key={entry.item.data.uuid}
					entry={entry}
					onOpen={onOpen}
				/>
			))}
		</div>
	)
}

function BrowseRow({ entry, onOpen }: { entry: BrowseEntry; onOpen: (entry: BrowseEntry) => void }) {
	const name = entryName(entry)

	return (
		<button
			type="button"
			role="listitem"
			onClick={() => {
				onOpen(entry)
			}}
			className={cn(
				"flex h-11 items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50"
			)}
		>
			<ItemIcon
				item={entry.item}
				className="size-5 shrink-0"
			/>
			<span className="min-w-0 flex-1 truncate">{name}</span>
			{entry.kind === "file" && (
				<span className="hidden w-24 shrink-0 text-right text-muted-foreground tabular-nums sm:block">
					{formatItemSize(entry.item)}
				</span>
			)}
			<span className="hidden w-28 shrink-0 text-right text-muted-foreground md:block">{formatModifiedDate(entry.item)}</span>
		</button>
	)
}
