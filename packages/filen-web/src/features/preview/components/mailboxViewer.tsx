import { useContext, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import * as Comlink from "comlink"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowLeftIcon } from "lucide-react"
import type { DriveItem } from "@/features/drive/lib/item"
import { EmailViewer } from "@/features/preview/components/emailViewer"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { useTextPagerSession, type TextPager } from "@/features/preview/hooks/useTextPagerSession"
import { PreviewByteOriginProvider, usePreviewOrigin, useProvidedPreviewOrigin } from "@/features/preview/lib/accessMode"
import { EmailLinkRootContext } from "@/features/preview/lib/emailLinkRoot"
import { embeddedFileItem } from "@/features/preview/lib/embeddedFileItem"
import type { EmailHeaderSummary } from "@/features/preview/lib/emailReading"
import type { MboxCount, MboxSearchEnd } from "@/features/preview/lib/textPager/mbox.logic"
import type { MboxMessage } from "@/features/preview/workers/textPager.worker"
import { bytesOrigin } from "@/lib/sdk/byteOrigin"
import { originServesRanges } from "@/features/drive/lib/preview.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { formatDateTime } from "@/lib/formatDate"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { log } from "@/lib/log"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@filen/shared"

// A mailbox (F1): its messages listed on the left, found only as far as the list is scrolled ("≥ N messages" until the
// end, Count all on request), and the one chosen on the right in the email viewer; on a narrow screen the message
// replaces the list, with a way back. Read in ranges in the pager worker, whatever the file's size.

const ROW_HEIGHT = 56
// A pause in typing before the search starts.
const SEARCH_DELAY_MS = 300
const OVERSCAN = 20
// Messages found beyond the last row in view, so scrolling rarely waits on the scan.
const SCAN_AHEAD = 200

type Rows = ReadonlyMap<number, EmailHeaderSummary>
// A header search: its matches so far (message indexes), how far it got, and how it ended (null while it runs).
interface Search {
	readonly query: string
	readonly matches: readonly number[]
	readonly searched: number
	readonly end: MboxSearchEnd | null
}
type Opened =
	| { readonly status: "pending"; readonly index: number }
	| { readonly status: "ok"; readonly index: number; readonly blob: Blob }
	| { readonly status: "tooLarge" | "failed"; readonly index: number }

// `position`: the row's 1-based place in the list, its name while its header is still being read. Never disabled then:
// keyboard navigation focuses rows still loading, and opening one works.
function MessageRow({
	row,
	position,
	selected,
	onOpen
}: {
	row: EmailHeaderSummary | undefined
	position: number
	selected: boolean
	onOpen: () => void
}) {
	const { t } = useTranslation("preview")
	const date = row?.date === null || row === undefined ? null : Date.parse(row.date)
	const className = cn(
		"flex size-full flex-col justify-center gap-0.5 border-b border-border/50 px-3 text-left text-sm hover:bg-accent",
		selected ? "bg-accent" : null
	)

	if (row === undefined) {
		return (
			<button
				type="button"
				aria-current={selected ? "true" : undefined}
				aria-label={t("previewMailboxRowLoading", { index: position })}
				aria-busy="true"
				onClick={onOpen}
				className={className}
			>
				<Skeleton className="h-4 w-1/2" />
				<Skeleton className="h-4 w-3/4" />
			</button>
		)
	}

	return (
		<button
			type="button"
			aria-current={selected ? "true" : undefined}
			onClick={onOpen}
			className={className}
		>
			<span className="flex min-w-0 items-baseline justify-between gap-2">
				<bdi className="min-w-0 truncate font-medium">{row.from ?? t("previewMailboxNoSender")}</bdi>
				<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
					{date === null || Number.isNaN(date) ? (row.date ?? "") : formatDateTime(date)}
				</span>
			</span>
			<bdi className="min-w-0 truncate text-muted-foreground">{row.subject ?? t("previewMailboxNoSubject")}</bdi>
		</button>
	)
}

function MessagePane({ item, opened }: { item: DriveItem; opened: Opened | null }) {
	const { t } = useTranslation("preview")

	if (opened === null) {
		return <p className="flex size-full items-center justify-center p-6 text-sm text-muted-foreground">{t("previewMailboxChoose")}</p>
	}

	switch (opened.status) {
		case "pending":
			return <PreviewLoading />
		case "failed":
			return <PreviewErrorState message={t("previewMailboxMessageFailed")} />
		case "tooLarge":
			return (
				<PreviewUnsupportedState
					item={item}
					message={t("previewMailboxMessageTooLarge")}
				/>
			)
		case "ok": {
			const message = embeddedFileItem(
				`${item.data.uuid}#msg${String(opened.index)}`,
				`message-${String(opened.index + 1)}.eml`,
				opened.blob.size,
				Number.NaN
			)

			return (
				<PreviewByteOriginProvider
					key={opened.index}
					origin={bytesOrigin(opened.blob, message.data.uuid)}
				>
					<EmailViewer item={message} />
				</PreviewByteOriginProvider>
			)
		}
	}
}

function SearchStatus({ search, onStop }: { search: Search; onStop: () => void }) {
	const { t } = useTranslation("preview")
	const count = search.matches.length
	const endText =
		search.end === "capped"
			? t("previewMailboxMatchesCapped", { count })
			: search.end === "stopped"
				? t("previewMailboxMatchesSoFar", { count })
				: t("previewMailboxMatches", { count })

	return (
		<div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-3 text-xs text-muted-foreground">
			{/* Read out once, when it ends: progress every few hundred messages would talk over everything. */}
			<span
				role="status"
				className="sr-only"
			>
				{search.end === null ? "" : endText}
			</span>
			<span
				aria-hidden="true"
				className="truncate tabular-nums"
			>
				{search.end === null ? t("previewMailboxSearching", { count, searched: search.searched }) : endText}
			</span>
			{search.end === null ? (
				<Button
					variant="ghost"
					size="sm"
					className="h-6 px-2 text-xs"
					onClick={onStop}
				>
					{t("previewMailboxStop")}
				</Button>
			) : null}
		</div>
	)
}

// `fail`: a read that failed (not one stopped) turns the viewer into its error state, with Try again.
function MailboxReader({ item, pager, fail }: { item: DriveItem; pager: TextPager; fail: (error: unknown) => void }) {
	const { t } = useTranslation("preview")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [count, setCount] = useState<MboxCount>({ count: 0, complete: false, capped: false, scanned: 0 })
	const [rows, setRows] = useState<Rows>(new Map())
	const [counting, setCounting] = useState(false)
	const [opened, setOpened] = useState<Opened | null>(null)
	const [filter, setFilter] = useState("")
	const [search, setSearch] = useState<Search | null>(null)
	const query = filter.trim()
	// While a query is active the list is its matches, in file order.
	const shown = search === null ? count.count : search.matches.length
	const messageAt = (row: number): number => (search === null ? row : (search.matches[row] ?? -1))
	const virtualizer = useVirtualizer({
		count: shown,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN
	})
	const range = virtualizer.getVirtualItems()
	const first = range[0]?.index ?? 0
	const last = range.at(-1)?.index ?? 0
	// Messages wanted found: the rows in view and SCAN_AHEAD beyond.
	const want = last + SCAN_AHEAD
	const matches = search?.matches ?? null

	useEffect(() => {
		let live = true

		if (matches !== null || count.complete || count.count >= want) {
			return
		}

		pager
			.run(remote => remote.mboxEnsure(want))
			.then(
				found => {
					if (live) setCount(found)
				},
				(e: unknown) => {
					log.error("preview", "scanning a mailbox failed", e)
					fail(e)
				}
			)

		return () => {
			live = false
		}
	}, [pager, want, count.complete, count.count, matches])

	// A query searches once typing pauses; an empty one shows every message again.
	useEffect(() => {
		if (query === "") {
			return
		}

		let live = true
		// Progress comes over the callback's own port, which keeps no order with the result's: a report that arrives after
		// the result would add its matches a second time.
		let ended = false
		const timer = setTimeout(() => {
			setSearch({ query, matches: [], searched: 0, end: null })
			pager
				.run(remote =>
					remote.mboxSearch(
						query,
						Comlink.proxy((searched: number, found: readonly number[]) => {
							if (!live || ended) return

							// An empty stretch keeps the matches as they are: the rows in view are not read again.
							setSearch(current =>
								current?.query !== query
									? current
									: found.length === 0
										? { ...current, searched }
										: { ...current, searched, matches: [...current.matches, ...found] }
							)
						})
					)
				)
				.then(
					result => {
						ended = true

						if (!live) return

						setSearch({ query, matches: result.matches, searched: result.searched, end: result.end })
					},
					(e: unknown) => {
						log.error("preview", "searching a mailbox failed", e)

						if (live) fail(e)
					}
				)
		}, SEARCH_DELAY_MS)

		return () => {
			live = false
			clearTimeout(timer)
		}
	}, [pager, query])

	// The rows read near the view; while a query is active, the messages they show, as a key: a search's progress reads
	// rows again only when the matches near the view change, not whenever matches are found further on. A search's end
	// reads them once more: until then a match past the messages the list scanned is readable only while the worker
	// still keeps its row, and its index adopts the search's scanner when the search ends.
	const from = Math.max(0, first - OVERSCAN)
	const to = Math.min(shown, last + OVERSCAN + 1)
	const nearMatches = matches === null ? null : matches.slice(from, to).join(",")
	const searchEnded = search !== null && search.end !== null

	useEffect(() => {
		let live = true

		if (to <= from) {
			return
		}

		const indexes = nearMatches === null ? null : nearMatches.split(",").map(Number)

		pager
			.run(remote => (indexes === null ? remote.mboxRows(from, to - from) : remote.mboxRowsOf(indexes)))
			.then(
				read => {
					if (!live) return

					// Only the rows near the view are kept on the page, by message; the worker keeps more. A match the worker no
					// longer keeps (read null) keeps the row the page already shows.
					setRows(previous => {
						const next = new Map<number, EmailHeaderSummary>()

						read.forEach((row, offset) => {
							const index = indexes === null ? from + offset : (indexes[offset] ?? -1)
							const kept = row ?? (indexes === null ? undefined : previous.get(index))

							if (kept !== undefined) next.set(index, kept)
						})

						return next
					})
				},
				(e: unknown) => {
					log.error("preview", "reading a mailbox's rows failed", e)
					fail(e)
				}
			)

		return () => {
			live = false
		}
	}, [pager, from, to, nearMatches, searchEnded])

	const [back, setBack] = useState<HTMLButtonElement | null>(null)
	// The mailbox is the file its messages' attachments are saved from, unless another file holds it.
	const outerRoot = useContext(EmailLinkRootContext)
	const held = useProvidedPreviewOrigin() !== null
	const root = outerRoot !== undefined ? outerRoot : held ? null : { uuid: item.data.uuid, parent: item.data.parent }
	// The list row a message shows at (its place among the matches while a query is active), or null.
	const shownRowOf = (index: number): number | null => {
		if (search === null) return index

		const row = search.matches.indexOf(index)

		return row === -1 ? null : row
	}
	// Brings row `row` into view and focuses it once it is laid out.
	const focusRow = (row: number): void => {
		virtualizer.scrollToIndex(row)
		requestAnimationFrame(() => {
			scrollElement?.querySelector<HTMLElement>(`[data-row="${String(row)}"] button`)?.focus()
		})
	}

	// On a narrow screen the list is hidden once a message opens: focus goes to the way back.
	useEffect(() => {
		if (back !== null && back.offsetParent !== null) back.focus()
	}, [back])

	const open = (index: number): void => {
		setOpened({ status: "pending", index })
		pager
			.run(async (remote): Promise<MboxMessage> => await remote.mboxMessage(index))
			.then(
				message => {
					setOpened(current =>
						current?.index !== index
							? current
							: message.status === "ok"
								? { status: "ok", index, blob: new Blob([message.bytes], { type: "message/rfc822" }) }
								: { status: message.status === "tooLarge" ? "tooLarge" : "failed", index }
					)
				},
				(e: unknown) => {
					log.error("preview", "reading a mailbox message failed", e)
					setOpened(current => (current?.index === index ? { status: "failed", index } : current))
				}
			)
	}

	const countAll = (): void => {
		// As a search's: a progress report that arrives after the count would take it back.
		let ended = false

		setCounting(true)
		pager
			.run(remote =>
				remote.mboxCountAll(
					Comlink.proxy((progress: MboxCount) => {
						if (!ended) setCount(progress)
					})
				)
			)
			.then(
				counted => {
					ended = true
					setCount(counted)
					setCounting(false)
				},
				(e: unknown) => {
					ended = true
					log.error("preview", "counting a mailbox failed", e)
					fail(e)
					setCounting(false)
				}
			)
	}

	const stopCount = (): void => {
		void pager.run(remote => remote.mboxStop()).catch(() => undefined)
	}
	const stopSearch = (): void => {
		void pager.run(remote => remote.mboxStopSearch()).catch(() => undefined)
	}

	const summary =
		count.complete && !count.capped
			? t("previewMailboxCount", { count: count.count })
			: t("previewMailboxAtLeast", { count: count.count })

	return (
		<div className="flex size-full overflow-hidden">
			<div
				className={cn(
					"flex min-w-0 flex-col border-r border-border md:w-80 md:shrink-0",
					opened === null ? "w-full" : "hidden md:flex"
				)}
			>
				<div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3 text-xs text-muted-foreground">
					<span className="tabular-nums">{summary}</span>
					{count.complete ? null : counting ? (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={stopCount}
						>
							{t("previewMailboxStop")}
						</Button>
					) : (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={countAll}
						>
							{t("previewMailboxCountAll")}
						</Button>
					)}
				</div>
				<div className="shrink-0 border-b border-border p-2">
					<Input
						type="search"
						value={filter}
						placeholder={t("previewMailboxSearch")}
						aria-label={t("previewMailboxSearch")}
						className="h-8 text-sm"
						onChange={event => {
							setFilter(event.target.value)

							// Cleared: every message again, the search stopped.
							if (event.target.value.trim() === "") {
								setSearch(null)
								stopSearch()
							}
						}}
					/>
				</div>
				{search === null ? null : (
					<SearchStatus
						search={search}
						onStop={stopSearch}
					/>
				)}
				<div
					ref={setScrollElement}
					role="list"
					aria-label={t("previewMailboxList")}
					className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto"
					onKeyDown={event => {
						const at = Number((event.target as HTMLElement).closest("[data-row]")?.getAttribute("data-row") ?? Number.NaN)
						const next =
							event.key === "ArrowDown"
								? at + 1
								: event.key === "ArrowUp"
									? at - 1
									: event.key === "Home"
										? 0
										: event.key === "End"
											? shown - 1
											: Number.NaN

						if (Number.isNaN(at) || Number.isNaN(next) || next < 0 || next >= shown) return

						event.preventDefault()
						focusRow(next)
					}}
				>
					<div
						className="relative w-full"
						style={{ height: virtualizer.getTotalSize() }}
					>
						{range.map(entry => {
							const index = messageAt(entry.index)

							return (
								<div
									key={entry.index}
									role="listitem"
									// The whole list's size and place, not the rows laid out.
									aria-setsize={shown}
									aria-posinset={entry.index + 1}
									data-row={entry.index}
									className="absolute top-0 left-0 w-full"
									style={{ height: ROW_HEIGHT, transform: `translateY(${String(entry.start)}px)` }}
								>
									<MessageRow
										row={rows.get(index)}
										position={entry.index + 1}
										selected={opened?.index === index}
										onOpen={() => {
											open(index)
										}}
									/>
								</div>
							)
						})}
					</div>
				</div>
			</div>
			<div className={cn("min-w-0 flex-1 flex-col", opened === null ? "hidden md:flex" : "flex")}>
				{opened === null ? null : (
					<Button
						variant="ghost"
						size="sm"
						className="m-1 self-start md:hidden"
						ref={setBack}
						onClick={() => {
							const row = shownRowOf(opened.index)

							setOpened(null)

							// Back where it came from: the row it was opened from.
							if (row !== null) focusRow(row)
						}}
					>
						<ArrowLeftIcon className="size-4" />
						{t("previewMailboxBack")}
					</Button>
				)}
				<div className="min-h-0 flex-1">
					<EmailLinkRootContext value={root}>
						<MessagePane
							item={item}
							opened={opened}
						/>
					</EmailLinkRootContext>
				</div>
			</div>
		</div>
	)
}

function MailboxSession({ item }: { item: DriveItem }) {
	// Binary parts (an 8-bit or binary transfer encoding) are no reason to refuse a mailbox: read it whatever its head.
	const session = useTextPagerSession(item, { textOnly: false })

	switch (session.status) {
		case "pending":
		case "notText":
			return <PreviewLoading />
		case "error":
			return (
				<PreviewErrorState
					message={errorLabel(session.dto)}
					onRetry={session.retry}
				/>
			)
		case "ready":
			return (
				<MailboxReader
					item={item}
					pager={session.reading.pager}
					fail={session.reading.fail}
				/>
			)
	}
}

// Read in ranges from any origin that serves them (originServesRanges, as the large text viewer); else too large.
export function MailboxViewer({ item }: { item: DriveItem }) {
	const { t } = useTranslation("preview")
	const origin = usePreviewOrigin(item)

	if (!originServesRanges(origin)) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewMailboxNoRanges")}
			/>
		)
	}

	return <MailboxSession item={item} />
}
