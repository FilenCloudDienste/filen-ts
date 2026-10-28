import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { FolderClosedIcon, MoreHorizontalIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"
import { withLibraryRoot, withoutLibraryRoot, type LibraryConfigDoc, type LibraryRootType, type Stamp } from "@filen/shared/videos"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { useIsOnline } from "@/lib/useIsOnline"
import { videoLibrary } from "@/features/videos/lib/index"
import { editLibraryConfig } from "@/features/videos/queries/library"
import { useDirectoryRootChainQuery } from "@/lib/directoryRoots"
import { useVideoLibraryView, useVideoRootNames } from "@/features/videos/hooks/useVideoLibraryView"
import { useCatalogHiddenQuery } from "@/features/videos/queries/catalog"
import { detectedRootKind, isRootBusy, type VideoKindCounts, type VideoLibraryRootView } from "@/features/videos/lib/libraryView.logic"
import { closeVideosDialogs, openVideosChooser, setVideosLibrariesOpen } from "@/features/videos/store/useVideosDialogStore"
import { videosFocusFallback } from "@/features/videos/lib/focusTargets"
import { unhideEdit } from "@/features/videos/lib/corrections.logic"
import type { VideoTitleView } from "@/workers/videoIndex/view.logic"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

type ConfigEdit = (doc: LibraryConfigDoc, stamp: Stamp) => LibraryConfigDoc

const TYPE_KEY = {
	auto: "videosTypeAuto",
	movies: "videosTypeMovies",
	shows: "videosTypeShows",
	other: "videosTypeOther"
} as const satisfies Record<LibraryRootType, string>

const ROOT_TYPES: readonly LibraryRootType[] = ["auto", "movies", "shows", "other"]

function Notice({ busy, children }: { busy?: boolean; children: string }) {
	return (
		<p className="flex items-start gap-2 text-sm text-warning-foreground">
			{busy === true ? (
				<Spinner
					aria-hidden="true"
					className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
				/>
			) : (
				<TriangleAlertIcon
					aria-hidden="true"
					className="mt-0.5 size-3.5 shrink-0"
				/>
			)}
			<span className={busy === true ? "text-muted-foreground" : undefined}>{children}</span>
		</p>
	)
}

function RootCard({
	root,
	name,
	counts,
	pending,
	onEdit,
	onRemove
}: {
	root: VideoLibraryRootView
	name: string
	counts: VideoKindCounts | undefined
	pending: boolean
	onEdit: (edit: ConfigEdit) => void
	onRemove: () => void
}) {
	const { t } = useTranslation(["videos", "common", "drive"])
	const { t: tCommon } = useTranslation("common")
	const navigate = useNavigate()
	const isOnline = useIsOnline()
	const now = useNowMinute()
	const chainQuery = useDirectoryRootChainQuery(root.uuid, true)
	const chain = chainQuery.data ?? null
	const status = root.status
	const detected = detectedRootKind(counts)
	const typeOptions = ROOT_TYPES.map(type => ({
		value: type,
		label: type === "auto" && detected !== null ? t("videosTypeAutoDetected", { kind: t(TYPE_KEY[detected]) }) : t(TYPE_KEY[type])
	}))
	const path =
		chain === null
			? name
			: chain.length <= 1
				? t("drive:driveMyDrive")
				: `/${chain
						.slice(1)
						.map(link => link.name)
						.join("/")}`
	const sizeEntries = status?.walkedEntries ?? 0
	const videos = t("videosLibraryVideos", { count: status?.videos ?? 0 })
	const shows = counts?.shows ?? 0
	const subline = root.enabled
		? t("videosLibrarySubline", {
				path,
				counts:
					shows > 0 ? t("videosLibraryCountsWithShows", { videos, shows: t("videosLibraryShows", { count: shows }) }) : videos,
				scan:
					(status?.completeAt ?? 0) > 0
						? t("videosLibraryScanned", { time: formatRelativeTime(status?.completeAt ?? 0, tCommon, now) })
						: t("videosLibraryNotScanned")
			})
		: t("videosLibrarySublineOff", { path })

	const disabled = pending || !isOnline

	return (
		<div
			role="group"
			aria-label={name}
		>
			<SettingsRow
				label={name}
				description={subline}
			>
				<Switch
					checked={root.enabled}
					disabled={disabled}
					aria-label={t("videosLibraryInclude", { name })}
					onCheckedChange={enabled => {
						onEdit((doc, stamp) => withLibraryRoot({ doc, dirUuid: root.uuid, enabled, stamp, now: Date.now() }))
					}}
				/>
			</SettingsRow>
			<div className="-mt-1 flex flex-col gap-2 px-5 pb-3.5">
				{root.enabled && isRootBusy(root.phase) ? <Notice busy>{t("videosLibraryScanning")}</Notice> : null}
				{root.enabled && root.phase === "missing" ? <Notice>{t("videosLibraryMissing")}</Notice> : null}
				{root.enabled && root.phase === "incomplete" ? (
					<Notice>{(status?.completeAt ?? 0) > 0 ? t("videosLibraryIncomplete") : t("videosLibraryIncompleteNoScan")}</Notice>
				) : null}
				{root.enabled && status?.moved === true ? <Notice>{t("videosLibraryMoved")}</Notice> : null}
				{root.enabled && status?.size === "large" ? <Notice>{t("videosLibrarySizeLarge", { files: sizeEntries })}</Notice> : null}
				{root.enabled && status?.size === "huge" ? <Notice>{t("videosLibrarySizeHuge", { files: sizeEntries })}</Notice> : null}
				<div className="flex flex-wrap items-center gap-2">
					<span
						id={`videos-type-${root.uuid}`}
						className="text-sm text-muted-foreground"
					>
						{t("videosLibraryType")}
					</span>
					<Select
						items={typeOptions}
						value={root.type}
						disabled={disabled}
						onValueChange={type => {
							if (type !== null) {
								onEdit((doc, stamp) => withLibraryRoot({ doc, dirUuid: root.uuid, type, stamp, now: Date.now() }))
							}
						}}
					>
						<SelectTrigger
							size="sm"
							aria-labelledby={`videos-type-${root.uuid}`}
							className="min-w-36"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{typeOptions.map(option => (
									<SelectItem
										key={option.value}
										value={option.value}
									>
										{option.label}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
					<Button
						variant="outline"
						size="sm"
						className="ml-auto"
						disabled={disabled || !root.enabled || isRootBusy(root.phase) || root.phase === "missing"}
						onClick={() => {
							videoLibrary.rescan(root.uuid).catch((e: unknown) => {
								log.warn("videos.libraries", "rescan failed", e)
							})
						}}
					>
						{t("videosRescan")}
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("videosLibraryMenu", { name })}
								>
									<MoreHorizontalIcon />
								</Button>
							}
						/>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								disabled={chain === null}
								onClick={() => {
									if (chain === null) {
										return
									}

									closeVideosDialogs()
									void navigate({
										to: "/drive/$",
										params: {
											_splat: chain
												.slice(1)
												.map(link => link.uuid)
												.join("/")
										}
									})
								}}
							>
								<FolderClosedIcon />
								{t("videosOpenInDrive")}
							</DropdownMenuItem>
							<DropdownMenuItem
								variant="destructive"
								disabled={disabled}
								onClick={onRemove}
							>
								{t("videosRemoveRoot")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
		</div>
	)
}

// The Libraries dialog: every library directory with its include switch, type, scan state, Rescan and Remove.
// Titles a correction hides, each with Show again (its correction keeps everything else).
function HiddenTitles({
	titles,
	pending,
	onEdit
}: {
	titles: readonly VideoTitleView[]
	pending: ReadonlySet<string>
	onEdit: (uuid: string, change: ConfigEdit) => Promise<boolean>
}) {
	const { t } = useTranslation("videos")

	return (
		<div className="mt-6">
			<SettingsGroup title={t("detailHiddenTitles")}>
				{titles.map(title => (
					<SettingsRow
						key={title.id}
						label={title.title}
						description={title.year > 0 ? String(title.year) : undefined}
					>
						<Button
							variant="outline"
							size="sm"
							disabled={pending.has(title.id)}
							onClick={() => {
								void onEdit(title.id, unhideEdit(title.id))
							}}
						>
							{t("detailUnhide")}
						</Button>
					</SettingsRow>
				))}
			</SettingsGroup>
		</div>
	)
}

// Mounted only while open; reads the configuration and the index's counts already held (hidden titles from the
// library's worker), so opening it costs no request beyond resolving the directories' paths (usually cached).
export function LibrariesDialog() {
	const { t } = useTranslation(["videos", "common"])
	const isOnline = useIsOnline()
	const { snapshot, roots } = useVideoLibraryView()
	const names = useVideoRootNames(roots)
	const counts = snapshot.summary.byRoot
	// Hidden titles are read from the library's worker only when there are any.
	const hiddenQuery = useCatalogHiddenQuery(snapshot.summary.hiddenCount > 0)
	const hidden = snapshot.summary.hiddenCount > 0 ? (hiddenQuery.data ?? []) : []
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
	const [removing, setRemoving] = useState<string | null>(null)
	const removingName = removing === null ? "" : (names.get(removing) ?? "")
	// What focus returns to once a removal took the menu that opened it away.
	const addRef = useRef<HTMLButtonElement>(null)

	// Promise handlers rather than try/finally, which the React Compiler can't compile yet.
	async function edit(uuid: string, change: ConfigEdit): Promise<boolean> {
		setPending(previous => new Set(previous).add(uuid))

		const saved = await editLibraryConfig(change).then(
			({ scanned }) => {
				scanned.catch((e: unknown) => {
					log.warn("videos.libraries", "scan after an edit failed", e)
				})

				return true
			},
			(e: unknown) => {
				toast.error(errorLabel(e))

				return false
			}
		)

		setPending(previous => {
			const next = new Set(previous)

			next.delete(uuid)

			return next
		})

		return saved
	}

	return (
		<>
			<Dialog
				open
				onOpenChange={open => {
					if (!open) {
						setVideosLibrariesOpen(false)
					}
				}}
			>
				<DialogContent
					// Sized to its cards up to the list dialogs' height. With the last directory removed, what opened it is
					// gone: focus goes to the first-run button or the heading.
					className="flex max-h-[min(48rem,calc(100dvh-2rem))] flex-col sm:max-w-3xl"
					finalFocus={() => (roots.length === 0 ? videosFocusFallback() : true)}
				>
					<DialogHeader>
						<DialogTitle>{t("videosLibrariesTitle")}</DialogTitle>
						<DialogDescription>{t("videosLibrariesDescription")}</DialogDescription>
					</DialogHeader>
					<div className="flex min-h-0 flex-col overflow-y-auto">
						{roots.length === 0 ? (
							<p className="py-8 text-center text-sm text-muted-foreground">{t("videosLibrariesNone")}</p>
						) : (
							<SettingsGroup>
								{roots.map(root => (
									<RootCard
										key={root.uuid}
										root={root}
										name={names.get(root.uuid) ?? ""}
										counts={counts.get(root.uuid)}
										pending={pending.has(root.uuid)}
										onEdit={change => {
											void edit(root.uuid, change)
										}}
										onRemove={() => {
											setRemoving(root.uuid)
										}}
									/>
								))}
							</SettingsGroup>
						)}
						{hidden.length === 0 ? null : (
							<HiddenTitles
								titles={hidden}
								pending={pending}
								onEdit={edit}
							/>
						)}
					</div>
					<DialogFooter className="sm:justify-between">
						<Button
							ref={addRef}
							variant="outline"
							disabled={!isOnline}
							onClick={() => {
								openVideosChooser()
							}}
						>
							<PlusIcon data-icon="inline-start" />
							{t("videosAddDirectory")}
						</Button>
						<Button
							onClick={() => {
								setVideosLibrariesOpen(false)
							}}
						>
							{t("videosLibrariesDone")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={removing !== null}
				pending={removing !== null && pending.has(removing)}
				finalFocus={addRef}
				title={t("videosRemoveConfirmTitle", { name: removingName })}
				body={t("videosRemoveConfirmBody", { name: removingName })}
				confirmLabel={t("videosRemoveConfirmAction")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setRemoving(null)
					}
				}}
				onConfirm={() => {
					if (removing === null) {
						return
					}

					void edit(removing, (doc, stamp) => withoutLibraryRoot({ doc, dirUuid: removing, stamp, at: Date.now() })).then(
						done => {
							if (done) {
								setRemoving(null)
							}
						}
					)
				}}
			/>
		</>
	)
}
