import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ALargeSmallIcon, AArrowDownIcon, AArrowUpIcon } from "lucide-react"
import { PdfEngineError, type MupdfFormat, type MupdfLayout } from "@filen/office/dom/pdfedit"
import type { MupdfPdfDocument } from "@filen/office/react/pdfedit"
import type { DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension } from "@/features/drive/lib/preview.logic"
import type { RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import { BAR_BUTTON, BAR_MENU, useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { MetadataCard } from "@/features/preview/components/metadataCard"
import { PdfReaderShell } from "@/features/preview/components/pdfReaderShell"
import { PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { usePreviewAccessMode, usePreviewCacheScope, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import {
	EBOOK_RESIZE_DEBOUNCE_MS,
	EBOOK_TEXT_SIZE_DEBOUNCE_MS,
	EBOOK_TEXT_SIZES,
	ebookLayout,
	ebookMetadataSections,
	ebookPageSize,
	ebookSizeCounts,
	ebookTextStep
} from "@/features/preview/lib/ebookLayout.logic"
import { setEbookTextSize, useEbookTextSize } from "@/features/preview/lib/ebookTextSize"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu"
import { LoadingState } from "@/components/loadingState"
import { deviceProfile } from "@/lib/deviceProfile"
import { log } from "@/lib/log"
import { mupdfImagePixels, openMupdfReader, type MupdfReader } from "@/lib/mupdf/reader"
import { originKey, originSize } from "@/lib/sdk/byteOrigin"
import { driveItemName } from "@filen/shared"

// The e-book reader (EPUB, MOBI, FB2): MuPDF lays the book out in its own engine, at a page the size of the view and
// the reader's text size, and its pages show in the PDF reader (find, outline, links, print). A new view size or text
// size lays the book out again: debounced, the engine running only the newest of the layouts asked, each request of an
// older layout cancelled, nothing while the page is hidden; meanwhile the pages freeze under a busy veil and come back
// at the text that was on screen. The page size is the pages area's (the reader shell's scroller), so the outline pane
// opening or closing beside it lays the book out again.

type ReaderState =
	| { readonly kind: "loading" }
	| { readonly kind: "open"; readonly reader: MupdfReader; readonly document: MupdfPdfDocument }
	| { readonly kind: "failed"; readonly failure: "notSupported" | "overBudget" | "readFailed" }

interface PageSize {
	readonly width: number
	readonly height: number
}

function failureOf(error: unknown): "notSupported" | "overBudget" | "readFailed" {
	if (error instanceof PdfEngineError && (error.failure === "notSupported" || error.failure === "overBudget")) return error.failure

	return "readFailed"
}

function formatOf(item: DriveItem): MupdfFormat {
	const extension = itemTypeExtension(item)

	return extension === "mobi" || extension === "fb2" ? extension : "epub"
}

export function EbookViewer({ item, alt }: { item: DriveItem; alt: string }) {
	useLeaveViewerFullScreen()

	const { t } = useTranslation("preview")
	const origin = usePreviewOrigin(item)
	const access = usePreviewAccessMode()
	const scope = usePreviewCacheScope()
	const em = useEbookTextSize()
	const format = formatOf(item)
	const key = originKey(origin)
	const rootRef = useRef<HTMLDivElement | null>(null)
	const [state, setState] = useState<ReaderState>({ kind: "loading" })
	const [attempt, setAttempt] = useState(0)
	// Layouts asked and not yet settled: the view is frozen while any is.
	const [relayouts, setRelayouts] = useState(0)
	// Resizes of the pages area that count, each restarting the resize debounce.
	const [resizes, setResizes] = useState(0)
	const [goTo, setGoTo] = useState<{ readonly page: number; readonly key: number } | null>(null)
	const pageRef = useRef(1)
	// What the book is laid out at (or asked to be), the pages area's latest page size and text size, the one pending
	// layout timer, and a layout asked while the page was hidden.
	const laidRef = useRef<MupdfLayout | null>(null)
	const sizeRef = useRef<PageSize | null>(null)
	const emRef = useRef(em)
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const hiddenRef = useRef<MupdfLayout | null>(null)
	// The engine broke once already: a second break after its reopen is the book's, not a fluke, and offers no Retry.
	const poisonedRef = useRef(false)
	const openArgs = useEffectEvent(() => ({ origin, access, scope, em }))

	// The book's engine, opened at the view's size (the pages area's own size, once known, lays it out again if it
	// differs) and closed with the viewer, a new file or a failure.
	useEffect(() => {
		const root = rootRef.current

		if (root === null) return

		const { origin: from, access: by, scope: cache, em: textSize } = openArgs()
		const size = ebookPageSize(root.clientWidth, root.clientHeight)
		const abort = new AbortController()
		let opened: MupdfReader | null = null

		laidRef.current = ebookLayout(size, textSize)
		sizeRef.current = size
		setState({ kind: "loading" })
		void openMupdfReader({
			origin: from,
			access: by,
			scope: cache,
			format,
			layout: laidRef.current,
			maxImagePixels: mupdfImagePixels(deviceProfile(), from, format),
			signal: abort.signal,
			onPoisoned: message => {
				log.warn("preview", "e-book engine poisoned", { message })
				setState({ kind: "failed", failure: poisonedRef.current ? "notSupported" : "readFailed" })
				poisonedRef.current = true
			}
		}).then(
			reader => {
				// Unmounted (or a new file) between the open's last check and here: nobody else would close it.
				if (abort.signal.aborted) {
					void reader.close()

					return
				}

				opened = reader
				setState({ kind: "open", reader, document: reader.document })
			},
			(error: unknown) => {
				if (abort.signal.aborted) return

				log.warn("preview", "e-book open failed", { error: error instanceof Error ? error.message : String(error) })
				setState({ kind: "failed", failure: failureOf(error) })
			}
		)

		return () => {
			abort.abort()
			void opened?.close()
		}
	}, [key, format, attempt])

	const reader = state.kind === "open" ? state.reader : null

	const relayout = useEffectEvent((layout: MupdfLayout) => {
		if (reader === null) return

		laidRef.current = layout
		setRelayouts(count => count + 1)
		void reader.relayout(layout, pageRef.current - 1).then(
			({ document: book, page }) => {
				// A later layout replaced this one meanwhile: its own answer brings the book.
				if (reader.document === book) {
					setState({ kind: "open", reader, document: book })
					setGoTo(previous => ({ page: page + 1, key: (previous?.key ?? 0) + 1 }))
				}

				setRelayouts(count => count - 1)
			},
			(error: unknown) => {
				setRelayouts(count => count - 1)

				if (error instanceof PdfEngineError && (error.failure === "cancelled" || error.failure === "closed")) return

				log.warn("preview", "e-book layout failed", { error: error instanceof Error ? error.message : String(error) })
				// The book can no longer be shown: its engine goes now, not with the viewer.
				void reader.close()
				setState({ kind: "failed", failure: failureOf(error) })
			}
		)
	})

	// The one layout timer: when it fires, the book is laid out at the latest page size that counts and the latest
	// text size, unless that is what it already has. A layout asked while the page is hidden waits for it to show.
	const schedule = useEffectEvent((delay: number) => {
		if (timerRef.current !== null) clearTimeout(timerRef.current)

		timerRef.current = setTimeout(() => {
			timerRef.current = null

			const laid = laidRef.current
			const size = sizeRef.current

			if (laid === null || size === null) return

			const next = ebookLayout(ebookSizeCounts(laid, size) ? size : laid, emRef.current)

			if (next.width === laid.width && next.height === laid.height && next.em === laid.em) return

			if (globalThis.document.visibilityState === "hidden") hiddenRef.current = next
			else relayout(next)
		}, delay)
	})

	useEffect(() => {
		if (reader === null) return

		const page = globalThis.document
		const onShow = (): void => {
			const pending = hiddenRef.current

			if (page.visibilityState === "hidden" || pending === null) return

			hiddenRef.current = null
			relayout(pending)
		}

		page.addEventListener("visibilitychange", onShow)

		return () => {
			page.removeEventListener("visibilitychange", onShow)
			hiddenRef.current = null

			if (timerRef.current !== null) {
				clearTimeout(timerRef.current)
				timerRef.current = null
			}
		}
	}, [reader])

	// The text size: a step lays the book out again once the steps pause.
	useEffect(() => {
		emRef.current = em

		if (reader !== null && laidRef.current !== null && laidRef.current.em !== em) schedule(EBOOK_TEXT_SIZE_DEBOUNCE_MS)
	}, [reader, em])

	// The pages area's size (the shell's scroller, beside the outline pane when it shows): a change that counts lays
	// the book out again once the resize settles.
	const onPagesResize = (width: number, height: number): void => {
		const size = ebookPageSize(width, height)
		const laid = laidRef.current

		sizeRef.current = size

		if (laid !== null && ebookSizeCounts(laid, size)) setResizes(count => count + 1)
	}

	useEffect(() => {
		if (reader !== null && resizes > 0) schedule(EBOOK_RESIZE_DEBOUNCE_MS)
	}, [reader, resizes])

	const textSize = useTextSizeGroup(em)

	let body: ReactNode

	if (state.kind === "loading") body = <PreviewLoading />
	else if (state.kind === "failed")
		body = (
			<PreviewUnsupportedState
				item={item}
				message={
					state.failure === "notSupported"
						? t("previewEbookUnsupported")
						: state.failure === "overBudget"
							? t("previewEbookTooLarge")
							: t("previewEbookReadFailed")
				}
				{...(state.failure === "readFailed"
					? {
							secondary: (
								<Button
									variant="outline"
									onClick={() => {
										setAttempt(value => value + 1)
									}}
								>
									{t("previewEbookRetry")}
								</Button>
							)
						}
					: {})}
			/>
		)
	else {
		const { reader: open, document: book } = state

		body = (
			<PdfReaderShell
				item={item}
				notice={null}
				document={book}
				viewerDocument={book}
				edit={null}
				alt={alt}
				size={originSize(origin)}
				fullyRead={false}
				ranged={false}
				resident={false}
				onReopen={() => undefined}
				signatures={{ kind: "current", verify: null, onViewSignedVersion: () => undefined }}
				fullReadGuard={false}
				onPagesResize={onPagesResize}
				commandGroups={[textSize]}
				pagesOverlay={
					relayouts > 0 ? (
						<div
							aria-hidden="true"
							className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/60 text-sm text-muted-foreground"
						>
							<LoadingState
								size="sm"
								className="text-inherit"
							/>
							{t("previewEbookRelayout")}
						</div>
					) : undefined
				}
				onPageChange={page => {
					pageRef.current = page
				}}
				goTo={goTo}
				renderProperties={(open_, onOpenChange) => (
					<Dialog
						open={open_}
						onOpenChange={onOpenChange}
					>
						<DialogContent data-preview-surface>
							<DialogHeader>
								<DialogTitle>{t("previewCommandBarProperties")}</DialogTitle>
							</DialogHeader>
							<MetadataCard
								title={open.metadata.title ?? driveItemName(item)}
								sections={ebookMetadataSections(open.metadata, open.pageCount, {
									title: t("previewCommandBarPropertyTitle"),
									author: t("previewCommandBarPropertyAuthor"),
									subject: t("previewCommandBarPropertySubject"),
									format: t("previewEbookPropertyFormat"),
									pages: t("previewCommandBarPropertyPages")
								})}
							/>
						</DialogContent>
					</Dialog>
				)}
			/>
		)
	}

	return (
		<div
			ref={rootRef}
			className="relative size-full"
		>
			{body}
			{/* Mounted for good, so the relayout is announced when it starts. */}
			<div
				role="status"
				className="sr-only"
			>
				{relayouts > 0 ? t("previewEbookRelayout") : ""}
			</div>
		</div>
	)
}

// The text size control: A− 11 pt A+ in the bar, an "Aa" menu of the sizes on a phone.
function useTextSizeGroup(em: number): RibbonGroup {
	const { t } = useTranslation("preview")
	const phone = usePhoneWidth()
	const label = t("previewEbookTextSize")

	if (phone) {
		return {
			id: "textSize",
			label,
			icon: ALargeSmallIcon,
			width: BAR_MENU,
			priority: 4,
			single: true,
			content: (
				<DropdownMenu>
					<RibbonMenuTrigger
						label={label}
						icon={<ALargeSmallIcon />}
					/>
					<DropdownMenuContent
						align="start"
						data-preview-surface
					>
						<DropdownMenuRadioGroup
							value={String(em)}
							onValueChange={(value: unknown) => {
								setEbookTextSize(Number(value))
							}}
						>
							{EBOOK_TEXT_SIZES.map(size => (
								<DropdownMenuRadioItem
									key={size}
									value={String(size)}
								>
									{t("previewEbookTextSizeValue", { size })}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			)
		}
	}

	return {
		id: "textSize",
		label,
		icon: ALargeSmallIcon,
		width: 2 * BAR_BUTTON + BAR_MENU,
		priority: 4,
		content: (
			<>
				<RibbonButton
					label={t("previewEbookTextSmaller")}
					icon={<AArrowDownIcon />}
					disabled={em <= EBOOK_TEXT_SIZES[0]}
					onClick={() => {
						setEbookTextSize(ebookTextStep(em, -1))
					}}
				/>
				<output
					aria-label={label}
					className="min-w-11 text-center text-xs text-muted-foreground tabular-nums"
				>
					{t("previewEbookTextSizeValue", { size: em })}
				</output>
				<RibbonButton
					label={t("previewEbookTextLarger")}
					icon={<AArrowUpIcon />}
					disabled={em >= (EBOOK_TEXT_SIZES.at(-1) ?? em)}
					onClick={() => {
						setEbookTextSize(ebookTextStep(em, 1))
					}}
				/>
			</>
		)
	}
}
