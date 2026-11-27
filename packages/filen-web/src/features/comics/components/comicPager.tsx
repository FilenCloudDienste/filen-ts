import {
	useEffect,
	useEffectEvent,
	useRef,
	useState,
	type FocusEvent as ReactFocusEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent
} from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeftIcon, ChevronRightIcon, Columns2Icon, ArrowLeftRightIcon } from "lucide-react"
import { DirectionProvider } from "@base-ui/react/direction-provider"
import { formatBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { useAction } from "@/lib/keymap/useAction"
import { readAheadEntries } from "@/lib/sdk/archiveListing"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingSession } from "@/features/archive/lib/listingSession"
import { entryLeaseOrigin, leaseEntry } from "@/features/archive/lib/archiveHandle"
import { entryCost, entryKey, entryReadPlan, needsCostConfirm, type ReadHeading } from "@/features/archive/lib/entryAccess.logic"
import { isArchivePasswordError } from "@/features/archive/lib/entryDownload"
import { ArchivePasswordGate } from "@/features/archive/components/archivePasswordPrompt"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { getPreviewBytes, joinPreviewBytes } from "@/features/preview/lib/previewCache"
import { usePreviewAccessMode, usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { ImageKeyGroupContext, type ImageKeyGroup, type ShownImage } from "@/features/preview/lib/imageDisplay"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { comicViews, landscapeOf, onScreen, pageOpens, viewLabel, viewOf } from "@/features/comics/lib/pages.logic"
import { setComicDirection, setComicLayout, useComicDirection, useComicLayout } from "@/features/comics/lib/comicPreferences"
import { ComicPage } from "@/features/comics/components/comicPage"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"
import { Slider } from "@/components/ui/slider"

export interface ComicPagerProps {
	source: ArchiveSource
	store: EntryStore
	// The page slots, in reading order (comicPages).
	pages: readonly number[]
	session: () => ListingSession | null
}

const NO_PAGES: ReadonlySet<number> = new Set()

// One page read ahead: its own lease, cancel token and abort, so a turn cancels only the pages it no longer needs.
interface AheadRead {
	readonly password: string | undefined
	readonly abort: AbortController
	readonly token: string
	readonly release: () => void
}

// Ends a page's read ahead: its fetch, its lease.
function cancelRead(running: Map<number, AheadRead>, slot: number, read: AheadRead): void {
	running.delete(slot)
	read.abort.abort()
	void sdkApi.cancelPreviewDownload(read.token)
	read.release()
}

function sliderPage(moved: number | readonly number[]): number {
	return (typeof moved === "number" ? moved : (moved[0] ?? 1)) - 1
}

// A comic's pages, a page or a spread at a time. PageUp/PageDown and the on-screen
// arrows turn pages; ←/→ stay with paging between files. Right to left puts the earlier page of a spread on the right,
// makes ◀ go forward and runs the slider from the right. Below the layout breakpoint a spread shows as single pages, the
// stored setting kept. A solid archive's later pages ask their cost once (the listing session's), as the archive
// browser does. The next view is read ahead once the shown one is on screen; a turn keeps the reads of the pages it
// turns to and cancels only the rest. A solid comic's window grows with the pages turned in a row (readAheadEntries).
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
	// The page the slider is dragged to, before it is let go.
	const [scrub, setScrub] = useState<number | null>(null)
	// Pages turned in a row, either way: the read-ahead window grows with them, and turning back keeps it, planned back.
	const [turns, setTurns] = useState(0)
	const [heading, setHeading] = useState<ReadHeading>("forward")
	// Pages on screen (or done failing), by slot and password.
	const [shownPages, setShownPages] = useState<ReadonlySet<string>>(() => new Set())
	const views = comicViews(pages.length, layout, landscape)
	const viewIndex = Math.max(0, viewOf(views, page))
	const view = views[viewIndex] ?? []
	const aheadEntries = readAheadEntries(turns)
	const reads = useRef(new Map<number, AheadRead>())
	const pagesRef = useRef<HTMLDivElement>(null)
	const activePage = useRef<Element | null>(null)
	const positions = new Map(pages.map((slot, position) => [slot, position]))
	const shownKey = (slot: number): string => `${String(slot)}:${password ?? ""}`

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

	// Shows the view `index`, or asks its cost first; true when it shows.
	const show = (index: number): boolean => {
		const target = views[Math.min(Math.max(index, 0), views.length - 1)]

		if (target === undefined) {
			return false
		}

		const costly = costlyIn(target)

		if (costly !== null) {
			setCostAsk(costly)

			return false
		}

		setDeclined(false)
		setPage(target[0] ?? 0)

		return true
	}

	const forward = (): void => {
		if (viewIndex < views.length - 1 && show(viewIndex + 1)) {
			setHeading("forward")
			setTurns(previous => previous + view.length)
		}
	}
	// The window read so far is turned around: a pass to an earlier page brings the pages before it, which it decodes
	// on its way anyway.
	const back = (): void => {
		if (viewIndex > 0 && show(viewIndex - 1)) {
			setHeading("back")
			setTurns(previous => previous + view.length)
		}
	}
	// A jump is no read in a row: the window starts small again.
	const jump = (position: number): void => {
		setTurns(0)
		setHeading("forward")
		show(viewOf(views, position))
	}

	const markLandscape = (position: number): void => {
		setLandscape(previous => (previous.has(position) ? previous : new Set([...previous, position])))
	}

	// A page's bytes, once in: its header tells a two-page scan before the picture is decoded.
	const sniffLandscape = useEffectEvent((slot: number, bytes: Uint8Array) => {
		const position = positions.get(slot)

		if (position !== undefined && landscapeOf(bytes) === true) {
			markLandscape(position)
		}
	})

	const initialCost = viewIndex === 0 && page === 0 && !declined && costAsk === null ? costlyIn(view) : null

	if (initialCost !== null) {
		setCostAsk(initialCost)
	}

	// Rebound to the view shown: a handler from an earlier render would turn from where it was.
	useAction("preview.comicNextPage", forward, undefined, [viewIndex, views])
	useAction("preview.comicPreviousPage", back, undefined, [viewIndex, views])

	// The shown pages' headers, from bytes their viewers loaded or are loading (joined, never fetched again).
	const viewSlots = view.map(position => pages[position] ?? -1)
	const viewKey = `${viewSlots.join(",")}:${cacheScope ?? ""}`
	const shownRead = useEffectEvent(() => ({ slots: viewSlots, scope: cacheScope }))

	useEffect(() => {
		const { slots, scope } = shownRead()
		let gone = false

		for (const slot of slots) {
			if (slot === -1) {
				continue
			}

			void joinPreviewBytes(scope, entryKey(source.uuid, store.index(slot))).then(bytes => {
				if (!gone && bytes !== undefined) {
					sniffLandscape(slot, bytes)
				}
			})
		}

		return () => {
			gone = true
		}
	}, [viewKey, source.uuid, store])

	// The next view the way the reader goes read ahead, once the shown one is on screen, and only when reading it asks
	// nothing.
	const next = views[heading === "back" ? viewIndex - 1 : viewIndex + 1]
	const blocked = declined || costlyIn(view) !== null
	const viewShown = view.every(position => shownPages.has(shownKey(pages[position] ?? -1)))
	const ahead = !blocked && viewShown && next !== undefined && costlyIn(next) === null && costAsk === null ? next : null
	const wanted = (ahead ?? []).flatMap(position => {
		const slot = pages[position]

		return slot !== undefined && pageOpens(store, slot) && !held(position) ? [slot] : []
	})
	const readsKey = `${wanted.join(",")}|${viewSlots.join(",")}|${password ?? ""}|${String(aheadEntries)}|${heading}`
	const plan = useEffectEvent(() => ({
		wanted,
		keep: new Set([...wanted, ...viewSlots]),
		password,
		aheadEntries,
		heading,
		costAccepted: session()?.costAccepted() === true
	}))

	useEffect(() => {
		const { wanted: wantedSlots, keep, password: readWith, aheadEntries: entries, heading: way, costAccepted } = plan()
		const running = reads.current

		// A page no longer wanted, nor shown now (a turn onto it keeps it: its viewer joins the read), is cancelled.
		for (const [slot, read] of running) {
			if (!keep.has(slot) || read.password !== readWith) {
				cancelRead(running, slot, read)
			}
		}

		for (const slot of wantedSlots) {
			if (running.has(slot)) {
				continue
			}

			const token = crypto.randomUUID()
			const leaseId = `${token}:${String(slot)}`
			const read: AheadRead = {
				password: readWith,
				abort: new AbortController(),
				token,
				release: leaseEntry({
					leaseId,
					target: source,
					password: readWith,
					plan: entryReadPlan(store, slot, costAccepted, undefined, entries, way),
					events: { phase: () => undefined, verified: () => undefined, failed: () => undefined }
				})
			}

			running.set(slot, read)
			loadOriginBytes(entryLeaseOrigin(leaseId, source.uuid, source.anon, store.index(slot), store.size(slot)), token, {
				access,
				cap: store.size(slot),
				scope: cacheScope,
				signal: read.abort.signal
			})
				.then(
					bytes => {
						sniffLandscape(slot, bytes)
					},
					() => undefined
				)
				.finally(() => {
					// Done: its bytes are in the preview cache, and a viewer reading them holds a lease of its own.
					if (running.get(slot) === read) {
						running.delete(slot)
						read.release()
					}
				})
				.catch(() => undefined)
		}
		// readsKey stands for what plan() reads.
	}, [readsKey, store, source.file, source.anon, access, cacheScope])

	useEffect(() => {
		const running = reads.current

		return () => {
			for (const [slot, read] of running) {
				cancelRead(running, slot, read)
			}
		}
	}, [])

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
	// What the read after a yes fetches: the page and the ones read ahead with it.
	const cost =
		costSlot === undefined ? null : entryCost(store, costSlot, entryReadPlan(store, costSlot, true, undefined, aheadEntries, heading))
	// ◀ goes forward when reading right to left.
	const left = direction === "rtl" ? forward : back
	const right = direction === "rtl" ? back : forward
	const atStart = viewIndex === 0
	const atEnd = viewIndex >= views.length - 1
	const label = viewLabel(view)
	const scrubbed = scrub === null ? label : viewLabel(views[viewOf(views, scrub)] ?? view)
	// Of a spread's two pages, the one last pointed at or focused takes the zoom keys; the first on screen before that.
	const keyGroup: ImageKeyGroup = {
		owns: element => {
			const owner = activePage.current?.isConnected === true ? activePage.current : pagesRef.current?.firstElementChild

			return owner?.contains(element) ?? true
		}
	}
	const activate = (event: ReactPointerEvent<HTMLElement> | ReactFocusEvent<HTMLElement>): void => {
		if (event.target instanceof Element) {
			activePage.current = event.target.closest("[data-comic-page]")
		}
	}
	// On the slider, Page Up and Page Down turn one view, as everywhere else in the reader (not ten pages).
	const sliderKeys = (event: ReactKeyboardEvent<HTMLElement>): void => {
		if (event.key !== "PageUp" && event.key !== "PageDown") {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		if (event.key === "PageDown") {
			forward()
		} else {
			back()
		}
	}

	return (
		<div className="flex size-full flex-col">
			<ImageKeyGroupContext value={keyGroup}>
				<div
					ref={pagesRef}
					className="flex min-h-0 flex-1 justify-center gap-1"
					onPointerOver={activate}
					onFocus={activate}
				>
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
										position={position}
										total={pages.length}
										password={password}
										readAhead={session()?.costAccepted() === true}
										aheadEntries={aheadEntries}
										heading={heading}
										onShown={(image: ShownImage | null) => {
											if (image !== null && image.width > image.height) {
												markLandscape(position)
											}

											setShownPages(previous => {
												const key = shownKey(slot)

												return previous.has(key) ? previous : new Set([...previous, key])
											})
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
			</ImageKeyGroupContext>
			<div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
				<TooltipIconButton
					size="icon"
					label={direction === "rtl" ? t("previewComicNext") : t("previewComicPrevious")}
					shortcut={<Kbd action={direction === "rtl" ? "preview.comicNextPage" : "preview.comicPreviousPage"} />}
					disabled={direction === "rtl" ? atEnd : atStart}
					onClick={left}
				>
					<ChevronLeftIcon />
				</TooltipIconButton>
				<div
					dir={direction}
					className="flex max-w-96 flex-1"
					onKeyDownCapture={sliderKeys}
				>
					<DirectionProvider direction={direction}>
						<Slider
							aria-label={t("previewComicPageSlider")}
							min={1}
							max={Math.max(pages.length, 1)}
							step={1}
							value={(scrub ?? view[0] ?? 0) + 1}
							className="flex-1"
							getAriaValueText={(_formatted, value) => t("previewComicPageOf", { page: value, total: pages.length })}
							// Dragging only moves the counter; the page is read once the slider is let go, and only then asks a cost.
							onValueChange={moved => {
								setScrub(sliderPage(moved))
							}}
							onValueCommitted={moved => {
								setScrub(null)
								jump(sliderPage(moved))
							}}
						/>
					</DirectionProvider>
				</div>
				<span
					aria-hidden="true"
					className="shrink-0 text-sm text-muted-foreground tabular-nums"
				>
					{t("previewComicCounter", { pages: scrubbed, total: pages.length })}
				</span>
				<span
					aria-live="polite"
					aria-atomic="true"
					className="sr-only"
				>
					{t("previewComicCounter", { pages: label, total: pages.length })}
				</span>
				<TooltipIconButton
					size="icon"
					label={direction === "rtl" ? t("previewComicPrevious") : t("previewComicNext")}
					shortcut={<Kbd action={direction === "rtl" ? "preview.comicPreviousPage" : "preview.comicNextPage"} />}
					disabled={direction === "rtl" ? atStart : atEnd}
					onClick={right}
				>
					<ChevronRightIcon />
				</TooltipIconButton>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{narrow ? null : (
						<TooltipIconButton
							variant={storedLayout === "spread" ? "secondary" : "ghost"}
							size="icon"
							label={t("previewComicSpread")}
							pressed={storedLayout === "spread"}
							onClick={() => {
								setComicLayout(storedLayout === "spread" ? "single" : "spread")
							}}
						>
							<Columns2Icon />
						</TooltipIconButton>
					)}
					<TooltipIconButton
						variant={direction === "rtl" ? "secondary" : "ghost"}
						size="icon"
						label={t("previewComicRightToLeft")}
						pressed={direction === "rtl"}
						onClick={() => {
							setComicDirection(direction === "rtl" ? "ltr" : "rtl")
						}}
					>
						<ArrowLeftRightIcon />
					</TooltipIconButton>
				</div>
			</div>
			<ConfirmDialog
				open={costAsk !== null}
				pending={false}
				title={t("previewArchiveEntryCostTitle")}
				body={
					costSlot === undefined || cost === null
						? ""
						: t("previewArchiveEntryCostOnceOpenBody", {
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
