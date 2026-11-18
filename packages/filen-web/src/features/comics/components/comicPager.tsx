import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeftIcon, ChevronRightIcon, Columns2Icon, ArrowLeftRightIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { useAction } from "@/lib/keymap/useAction"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingSession } from "@/features/archive/lib/listingSession"
import { entryLeaseOrigin, leaseEntry } from "@/features/archive/lib/archiveHandle"
import { entryCost, entryKey, needsCostConfirm } from "@/features/archive/lib/entryAccess.logic"
import { isArchivePasswordError } from "@/features/archive/lib/entryDownload"
import { ArchivePasswordGate } from "@/features/archive/components/archivePasswordPrompt"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { getPreviewBytes } from "@/features/preview/lib/previewCache"
import { usePreviewAccessMode, usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { comicViews, onScreen, viewLabel, viewOf } from "@/features/comics/lib/pages.logic"
import { setComicDirection, setComicLayout, useComicDirection, useComicLayout } from "@/features/comics/lib/comicPreferences"
import { ComicPage } from "@/features/comics/components/comicPage"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"

export interface ComicPagerProps {
	source: ArchiveSource
	store: EntryStore
	// The page slots, in reading order (comicPages).
	pages: readonly number[]
	session: () => ListingSession | null
}

const NO_PAGES: ReadonlySet<number> = new Set()

// A comic's pages, a page or a spread at a time (owner decisions E7/E8, W6 §6.3 A). PageUp/PageDown and the on-screen
// arrows turn pages; ←/→ stay with paging between files. Right to left puts the earlier page of a spread on
// the right and makes ◀ go forward. Below the layout breakpoint a spread shows as single pages, the stored setting
// kept. A solid archive's later pages ask their cost once (the listing session's), as the archive browser does; the
// next view is read ahead only after the shown one arrived, and a turn cancels it.
export function ComicPager({ source, store, pages, session }: ComicPagerProps) {
	const { t } = useTranslation(["preview", "common"])
	const access = usePreviewAccessMode()
	const cacheScope = usePreviewCacheScope()
	const narrow = useIsNarrowViewport()
	const storedLayout = useComicLayout()
	const direction = useComicDirection()
	const layout = narrow ? "single" : storedLayout
	const [landscape, setLandscape] = useState<ReadonlySet<number>>(NO_PAGES)
	// The first page of the view shown: a layout change keeps it in view.
	const [page, setPage] = useState(0)
	const [costAsk, setCostAsk] = useState<number | null>(null)
	const [declined, setDeclined] = useState(false)
	const [password, setPassword] = useState(() => session()?.password())
	const [passwordAsk, setPasswordAsk] = useState<{ wrong: boolean } | null>(null)
	const views = comicViews(pages.length, layout, landscape)
	const viewIndex = Math.max(0, viewOf(views, page))
	const view = views[viewIndex] ?? []

	const held = (position: number): boolean => {
		const slot = pages[position]

		return slot !== undefined && getPreviewBytes(cacheScope, entryKey(source.uuid, store.index(slot))) !== undefined
	}

	// A view's first page that costs reading the archive's earlier files, when the session has not accepted that yet.
	const costlyIn = (target: readonly number[]): number | null => {
		if (session()?.costAccepted() === true) {
			return null
		}

		return target.find(position => !held(position) && needsCostConfirm(store, pages[position] ?? -1)) ?? null
	}

	const show = (index: number): void => {
		const target = views[Math.min(Math.max(index, 0), views.length - 1)]

		if (target === undefined) {
			return
		}

		const costly = costlyIn(target)

		if (costly !== null) {
			setCostAsk(costly)

			return
		}

		setDeclined(false)
		setPage(target[0] ?? 0)
	}

	const initialCost = viewIndex === 0 && page === 0 && !declined && costAsk === null ? costlyIn(view) : null

	if (initialCost !== null) {
		setCostAsk(initialCost)
	}

	// Rebound to the view shown: a handler from an earlier render would turn from where it was.
	useAction(
		"preview.comicNextPage",
		() => {
			show(viewIndex + 1)
		},
		undefined,
		[viewIndex, views]
	)
	useAction(
		"preview.comicPreviousPage",
		() => {
			show(viewIndex - 1)
		},
		undefined,
		[viewIndex, views]
	)

	// The next view read ahead, once the shown one is in (its viewers' own loads, joined), and only when reading it
	// asks nothing. A turn or a jump cancels it.
	const next = views[viewIndex + 1]
	const blocked = declined || costlyIn(view) !== null
	const ahead = !blocked && next !== undefined && costlyIn(next) === null && costAsk === null ? next : null
	// What the read-ahead reads: a new array of the same pages is the same read-ahead.
	const aheadKey = ahead === null ? "" : `${view.join(",")}>${ahead.join(",")}:${password ?? ""}`
	const aheadRead = useEffectEvent(() => ({ ahead, view, password }))

	useEffect(() => {
		const { ahead: reading, view: shown, password: readWith } = aheadRead()

		if (reading === null) {
			return
		}

		const abort = new AbortController()
		const token = crypto.randomUUID()
		const releases: (() => void)[] = []
		const load = (position: number): Promise<unknown> => {
			const slot = pages[position]

			if (slot === undefined) {
				return Promise.resolve()
			}

			const leaseId = `${token}:${String(slot)}`

			releases.push(
				leaseEntry({
					leaseId,
					file: source.file,
					anon: source.anon,
					password: readWith,
					store,
					slot,
					events: { phase: () => undefined, verified: () => undefined, failed: () => undefined }
				})
			)

			return loadOriginBytes(entryLeaseOrigin(leaseId, source.file, source.anon, store, slot), token, {
				access,
				cap: store.size(slot),
				scope: cacheScope,
				signal: abort.signal
			})
		}

		void (async () => {
			await Promise.all(shown.map(load))

			for (const position of reading) {
				await load(position)
			}
		})().catch(() => undefined)

		return () => {
			abort.abort()
			void sdkApi.cancelPreviewDownload(token)

			for (const release of releases) {
				release()
			}
		}
	}, [aheadKey, pages, store, source.file, source.anon, access, cacheScope])

	if (passwordAsk !== null) {
		return (
			<ArchivePasswordGate
				name={source.name}
				wrong={passwordAsk.wrong}
				onSubmit={next => {
					setPassword(next)
					setPasswordAsk(null)
				}}
			/>
		)
	}

	const costSlot = costAsk === null ? undefined : pages[costAsk]
	const cost = costSlot === undefined ? null : entryCost(store, costSlot)
	const forward = (): void => {
		show(viewIndex + 1)
	}
	const back = (): void => {
		show(viewIndex - 1)
	}
	// ◀ goes forward when reading right to left.
	const left = direction === "rtl" ? forward : back
	const right = direction === "rtl" ? back : forward
	const atStart = viewIndex === 0
	const atEnd = viewIndex >= views.length - 1

	return (
		<div className="flex size-full flex-col">
			<div className="flex min-h-0 flex-1 justify-center gap-1">
				{blocked
					? null
					: onScreen(view, direction).map(position => {
							const slot = pages[position] ?? -1

							return (
								<ComicPage
									key={`${String(slot)}:${password ?? ""}`}
									source={source}
									store={store}
									slot={slot}
									password={password}
									onLandscape={() => {
										setLandscape(previous => (previous.has(position) ? previous : new Set([...previous, position])))
									}}
									onVerified={() => {
										if (password !== undefined) {
											session()?.acceptPassword(password)
										}
									}}
									onFailed={error => {
										if (isArchivePasswordError(error)) {
											setPasswordAsk({ wrong: error.kind === "ArchiveWrongPassword" || password !== undefined })
										}
									}}
									onCancelWait={() => {
										setDeclined(true)
									}}
								/>
							)
						})}
				{declined ? (
					<PreviewErrorState
						message={t("previewComicNotOpened")}
						onRetry={() => {
							show(viewIndex)
						}}
					/>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
				<Button
					variant="ghost"
					size="icon"
					aria-label={direction === "rtl" ? t("previewComicNext") : t("previewComicPrevious")}
					disabled={direction === "rtl" ? atEnd : atStart}
					onClick={left}
				>
					<ChevronLeftIcon />
				</Button>
				<Slider
					aria-label={t("previewComicPageSlider")}
					min={1}
					max={Math.max(pages.length, 1)}
					step={1}
					value={(view[0] ?? 0) + 1}
					className="max-w-96 flex-1"
					onValueChange={moved => {
						const target = (typeof moved === "number" ? moved : (moved[0] ?? 1)) - 1

						show(viewOf(views, target))
					}}
				/>
				<span className="shrink-0 text-sm text-muted-foreground tabular-nums">
					{t("previewComicCounter", { pages: viewLabel(view), total: pages.length })}
				</span>
				<Button
					variant="ghost"
					size="icon"
					aria-label={direction === "rtl" ? t("previewComicPrevious") : t("previewComicNext")}
					disabled={direction === "rtl" ? atStart : atEnd}
					onClick={right}
				>
					<ChevronRightIcon />
				</Button>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{narrow ? null : (
						<Button
							variant={storedLayout === "spread" ? "secondary" : "ghost"}
							size="icon"
							aria-label={t("previewComicSpread")}
							title={t("previewComicSpread")}
							aria-pressed={storedLayout === "spread"}
							onClick={() => {
								setComicLayout(storedLayout === "spread" ? "single" : "spread")
							}}
						>
							<Columns2Icon />
						</Button>
					)}
					<Button
						variant={direction === "rtl" ? "secondary" : "ghost"}
						size="icon"
						aria-label={t("previewComicRightToLeft")}
						title={t("previewComicRightToLeft")}
						aria-pressed={direction === "rtl"}
						onClick={() => {
							setComicDirection(direction === "rtl" ? "ltr" : "rtl")
						}}
					>
						<ArrowLeftRightIcon />
					</Button>
				</div>
			</div>
			<ConfirmDialog
				open={costAsk !== null}
				pending={false}
				title={t("previewArchiveEntryCostTitle")}
				body={
					costSlot === undefined || cost === null
						? ""
						: t("previewArchiveEntryCostOpenBody", {
								name: store.name(costSlot),
								download: formatBytes(cost.estimatedBytes),
								skipped: formatBytes(cost.skippedBytes)
							})
				}
				confirmLabel={t("previewArchiveEntryCostOpen")}
				cancelLabel={t("common:cancel")}
				onOpenChange={open => {
					if (!open && costAsk !== null) {
						setCostAsk(null)

						// Declined on the first view: nothing is shown until asked again.
						if (viewIndex === 0 && page === 0 && costlyIn(view) !== null) {
							setDeclined(true)
						}
					}
				}}
				onConfirm={() => {
					const asked = costAsk

					setCostAsk(null)
					session()?.acceptCost()

					if (asked !== null) {
						setDeclined(false)
						setPage(views[viewOf(views, asked)]?.[0] ?? asked)
					}
				}}
			/>
		</div>
	)
}
