import { useEffect, useId, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { AudioWaveformIcon, BookmarkIcon, BookmarkMinusIcon, BookmarkPlusIcon, ScissorsIcon } from "lucide-react"
import { bookmarkProblem, MEDIA_BOOKMARKS_MAX, MEDIA_TIME_MAX_MS, type MediaTiming } from "@filen/office/core/anim"
import type { DeckOp, EffectTiming, ShapeRef, SlideMediaInfo, SlideRender } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import {
	knownMediaDuration,
	noteMediaDuration,
	selectedShapes,
	useShapeSelection,
	type ShowMediaStreams
} from "@filen/office/react/presentation"
import { FormDialog } from "@/components/dialogs/formDialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioItem
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { keepFocus } from "@/features/office/lib/officeControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { useRibbonDialog } from "@/features/presentation/components/ribbon/ribbonDialogs"
import { mediaStreams } from "@/features/presentation/hooks/useMediaInsert"
import { rangePortReader } from "@/lib/media/rangePort"
import type {
	PresentationGroups,
	PresentationRibbonContext,
	PresentationRibbonEditor
} from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// The Video and Audio tabs' Editing group (Trim, Fade) and Bookmarks group (Add, Remove) for the selected clip, each
// one op of the mediaTiming family (MS-PPTX p14:media trim, fade and bookmark list); and the Animations ▸ Trigger
// menu's bookmark items, which start an effect when a clip on the slide reaches a bookmark. Trim asks for the start
// and end times of the part that plays, as PowerPoint does, against the clip's length; the file stores what is cut
// from each end. Without a length (its metadata unreadable) it asks for those cuts directly.

type MediaKind = SlideMediaInfo["kind"]

const MAX_SECONDS = MEDIA_TIME_MAX_MS / 1000

// Seconds as typed ("1.5", "1,5", "2 s", "1:05.5"), or undefined outside [0, MAX_SECONDS].
export function parseMediaSeconds(text: string): number | undefined {
	const trimmed = text.trim().replace(",", ".").replace(/\s*s$/u, "")
	const parts = trimmed.split(":")

	if (trimmed === "" || parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/u.test(part))) return undefined

	const value = parts.reduce((sum, part) => sum * 60 + Number(part), 0)

	return Number.isFinite(value) && value <= MAX_SECONDS ? value : undefined
}

// Milliseconds as the fields show them (seconds, at most three decimals).
export function secondsText(ms: number): string {
	return String(Math.round(ms) / 1000)
}

function useSelectedMedia(
	editor: PresentationRibbonEditor,
	kind: MediaKind
): { readonly target: ShapeRef; readonly media: SlideMediaInfo } | undefined {
	const state = useShapeSelection(editor.selection)
	const render = editor.render
	const selected = selectedShapes(render, state)
	const only = selected.length === 1 ? selected[0] : undefined
	const layer =
		only === undefined ? undefined : render?.layers.find(candidate => candidate.box?.id === only.id && candidate.media !== undefined)

	if (render === undefined || only === undefined || layer?.media?.kind !== kind) return undefined

	return { target: { slide: render.ref, id: only.id }, media: layer.media }
}

// A seconds field. Its error shows once the field was left or the dialog submitted (`shown`), never while typing, and is
// linked to the input. `invalid` replaces the parse error's words (the Trim times dialog names the clip's length).
function SecondsInput({
	label,
	value,
	onChange,
	error,
	invalid,
	shown
}: {
	label: PreviewKey
	value: string
	onChange: (value: string) => void
	error?: string | undefined
	invalid?: string | undefined
	shown: boolean
}) {
	const { t } = useTranslation("preview")
	const id = useId()
	const errorId = useId()
	const [left, setLeft] = useState(false)
	const message = parseMediaSeconds(value) === undefined ? (invalid ?? t("previewPptxMediaSecondsRange", { max: MAX_SECONDS })) : error
	const visible = message !== undefined && (shown || left)

	return (
		<Field>
			<FieldLabel htmlFor={id}>{t(label)}</FieldLabel>
			<Input
				id={id}
				inputMode="decimal"
				value={value}
				aria-invalid={visible}
				aria-describedby={visible ? errorId : undefined}
				className="leading-5"
				onChange={event => {
					onChange(event.target.value)
				}}
				onBlur={() => {
					setLeft(true)
				}}
			/>
			{visible ? <FieldError id={errorId}>{message}</FieldError> : null}
		</Field>
	)
}

// How long to wait for a clip's metadata before Trim falls back to the cuts.
const METADATA_TIMEOUT_MS = 10_000

// ISO BMFF top-level boxes a file may start with (ISO/IEC 14496-12 §4.2; QuickTime's wide/pnot).
const LEADING_BOXES: ReadonlySet<string> = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"])
// Bounds of the container read: top-level boxes walked, and the most of the moov read (its mvhd comes first).
const MAX_BOXES = 64
const MAX_MOOV_READ = 1_048_576

type ContainerLength = { readonly kind: "known"; readonly ms: number } | { readonly kind: "unreadable" } | { readonly kind: "unknown" }

function boxType(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
}

// An MP4/MOV's length from its mvhd (ISO/IEC 14496-12 §8.2.2), read by box headers (a moov at the end, as a
// camera writes it, takes a few small reads, never the media): "unknown" for a file that is no ISO BMFF (it goes to a
// media element), "unreadable" for one whose boxes or mvhd do not hold together (an element could not play it either).
export async function isobmffLength(size: number, read: (start: number, end: number) => Promise<Uint8Array>): Promise<ContainerLength> {
	let at = 0

	for (let count = 0; count < MAX_BOXES && at + 8 <= size; count++) {
		const head = await read(at, Math.min(size, at + 16))
		const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
		const type = boxType(head, 4)

		if (count === 0 && !LEADING_BOXES.has(type)) return { kind: "unknown" }

		const small = view.getUint32(0)
		const length = small === 1 && head.length >= 16 ? Number(view.getBigUint64(8)) : small === 0 ? size - at : small
		const header = small === 1 ? 16 : 8

		if (!Number.isSafeInteger(length) || length < header || at + length > size) return { kind: "unreadable" }

		if (type === "moov") {
			const moov = await read(at + header, Math.min(at + length, at + header + MAX_MOOV_READ))
			const box = new DataView(moov.buffer, moov.byteOffset, moov.byteLength)

			for (let inner = 0; inner + 8 <= moov.length;) {
				const innerLength = box.getUint32(inner)

				if (innerLength < 8) return { kind: "unreadable" }

				if (boxType(moov, inner + 4) === "mvhd" && inner + 32 <= moov.length) {
					const version = moov[inner + 8] ?? 0
					const timescale = box.getUint32(inner + (version === 1 ? 28 : 20))
					const duration = version === 1 ? Number(box.getBigUint64(inner + 32)) : box.getUint32(inner + 24)

					// All ones is QuickTime's "unknown"; zero, a fragmented file's empty movie.
					return timescale > 0 && duration > 0 && duration !== 0xffffffff && Number.isFinite(duration)
						? { kind: "known", ms: (duration / timescale) * 1000 }
						: { kind: "unreadable" }
				}

				inner += innerLength
			}

			return { kind: "unreadable" }
		}

		at += length
	}

	return { kind: "unreadable" }
}

// The clip's length from its container, read through the session's range port (no media element: one that fails
// to decode a clip cuts its streaming request, which Firefox reports as a failed load).
async function containerLength(session: PresentationSessionApi, part: string, timeoutMs: number): Promise<ContainerLength> {
	const { port1, port2 } = new MessageChannel()
	let reader: ReturnType<typeof rangePortReader> | undefined

	try {
		reader = rangePortReader(port2)

		const deadline = AbortSignal.timeout(timeoutMs)
		const meta = await session.media(part, port1)

		if ("reason" in meta) return { kind: "unknown" }

		const read = reader

		return await isobmffLength(meta.size, (start, end) => read.readRange(start, end, deadline))
	} catch {
		return { kind: "unknown" }
	} finally {
		if (reader === undefined) port2.close()
		else reader.close()
	}
}

// The clip's length (ms): what the page's player learnt when it loaded the clip, else what an MP4's container says,
// else (another container) its metadata alone streamed into a detached element (preload "metadata": the container's
// header by range, never the whole file), then let go. Undefined when it cannot be read.
export async function readMediaDuration(
	session: PresentationSessionApi,
	media: SlideMediaInfo,
	streams: ShowMediaStreams = mediaStreams(undefined, undefined),
	timeoutMs = METADATA_TIMEOUT_MS
): Promise<number | undefined> {
	const part = media.part

	if (part === undefined) return undefined

	const known = knownMediaDuration(session, part)

	if (known !== undefined) return known

	const container = await containerLength(session, part, timeoutMs)

	if (container.kind === "known") {
		noteMediaDuration(session, part, container.ms / 1000)

		return knownMediaDuration(session, part)
	}

	if (container.kind === "unreadable") return undefined

	const stream = await streams.url(session, media).catch(() => ({ kind: "refused" as const }))

	if (stream.kind !== "url") return undefined

	const element = document.createElement(media.kind === "video" ? "video" : "audio")

	try {
		element.preload = "metadata"
		element.muted = true

		const seconds = await new Promise<number | undefined>(resolve => {
			const timer = setTimeout(() => {
				resolve(undefined)
			}, timeoutMs)
			const done = (value: number | undefined): void => {
				clearTimeout(timer)
				resolve(value)
			}

			element.addEventListener("loadedmetadata", () => {
				done(element.duration)
			})
			element.addEventListener("error", () => {
				done(undefined)
			})
			element.src = stream.url
		})

		if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined

		noteMediaDuration(session, part, seconds)

		return knownMediaDuration(session, part)
	} finally {
		// The stream let go: the service worker ends a response still open as a finished body, and the element, paused
		// and dropped unplayed, keeps its source until then. Unlinking it would cut its request while the response still
		// streams, which Firefox reports as a failed load (and an unreadable clip's errored load is still open).
		element.pause()
		stream.release()
	}
}

// The clip's length for a dialog: "reading" until known, undefined when it cannot be read.
function useMediaDuration(session: PresentationSessionApi, media: SlideMediaInfo): number | "reading" | undefined {
	const part = media.part
	const known = part === undefined ? undefined : knownMediaDuration(session, part)
	const [read, setRead] = useState<{ readonly part: string | undefined; readonly ms: number | undefined } | undefined>(undefined)

	useEffect(() => {
		if (known !== undefined) return

		let live = true

		void readMediaDuration(session, media).then(ms => {
			if (live) setRead({ part, ms })
		})

		return () => {
			live = false
		}
	}, [session, media, part, known])

	if (known !== undefined) return known

	return read !== undefined && read.part === part ? read.ms : "reading"
}

// Trim by its start and end times within the clip's length `durationMs`: stored as the cuts from each end. A time left
// as shown keeps its cut exactly (no rounding through the length).
function TrimTimesDialog({
	target,
	timing,
	durationMs,
	run,
	onClose
}: {
	target: ShapeRef
	timing: MediaTiming | undefined
	durationMs: number
	run: (op: DeckOp) => void
	onClose: () => void
}) {
	const { t } = useTranslation("preview")
	const startMs = timing?.trim?.startMs ?? 0
	const endMs = timing?.trim?.endMs ?? 0
	const shownStart = secondsText(Math.min(startMs, durationMs))
	const shownEnd = secondsText(Math.max(0, durationMs - endMs))
	const [start, setStart] = useState(shownStart)
	const [end, setEnd] = useState(shownEnd)
	const a = parseMediaSeconds(start)
	const b = parseMediaSeconds(end)
	const startAt = a === undefined ? undefined : Math.round(a * 1000)
	const endAt = b === undefined ? undefined : Math.round(b * 1000)
	const length = secondsText(durationMs)
	const beyond = (startAt !== undefined && startAt > durationMs) || (endAt !== undefined && endAt > durationMs)
	const order = !beyond && startAt !== undefined && endAt !== undefined && startAt >= endAt
	const outside = t("previewPptxMediaTrimBeyond", { time: length })
	const [submitted, setSubmitted] = useState(false)

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewPptxMediaTrim")}
			description={t("previewPptxMediaTrimTimesDescription", { time: length })}
			submitLabel={t("previewPptxObjectsApply")}
			cancelLabel={t("previewPptxInsertCancel")}
			canSubmit
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (startAt === undefined || endAt === undefined || beyond || order) {
					setSubmitted(true)

					return
				}

				run({
					family: "mediaTiming",
					kind: "setTrim",
					target,
					startMs: start === shownStart ? startMs : startAt,
					endMs: end === shownEnd ? endMs : durationMs - endAt
				})
				onClose()
			}}
		>
			<SecondsInput
				label="previewPptxMediaTrimStartTime"
				value={start}
				onChange={setStart}
				invalid={outside}
				shown={submitted}
				error={startAt !== undefined && startAt > durationMs ? outside : undefined}
			/>
			<SecondsInput
				label="previewPptxMediaTrimEndTime"
				value={end}
				onChange={setEnd}
				invalid={outside}
				shown={submitted}
				error={endAt !== undefined && endAt > durationMs ? outside : order ? t("previewPptxMediaTrimOrder") : undefined}
			/>
		</FormDialog>
	)
}

// Trim: by start and end times once the clip's length is known; while it is read, a dialog that says so; without
// it, the cuts from each end.
function TrimDialog({
	session,
	media,
	target,
	run,
	onClose
}: {
	session: PresentationSessionApi
	media: SlideMediaInfo
	target: ShapeRef
	run: (op: DeckOp) => void
	onClose: () => void
}) {
	const { t } = useTranslation("preview")
	const duration = useMediaDuration(session, media)

	if (duration === "reading")
		return (
			<FormDialog
				open
				pending={false}
				title={t("previewPptxMediaTrim")}
				description={t("previewPptxMediaTrimNeutral")}
				submitLabel={t("previewPptxObjectsApply")}
				cancelLabel={t("previewPptxInsertCancel")}
				canSubmit={false}
				onOpenChange={open => {
					if (!open) onClose()
				}}
				onSubmit={event => {
					event.preventDefault()
				}}
			>
				<p
					role="status"
					className="text-sm text-muted-foreground"
				>
					{t("previewPptxMediaTrimReading")}
				</p>
			</FormDialog>
		)

	if (duration === undefined)
		return (
			<PairDialog
				kind="trim"
				target={target}
				timing={media.timing}
				run={run}
				onClose={onClose}
				hint={t("previewPptxMediaTrimNoLength")}
			/>
		)

	return (
		<TrimTimesDialog
			target={target}
			timing={media.timing}
			durationMs={duration}
			run={run}
			onClose={onClose}
		/>
	)
}

// Trim (by its cuts) or Fade: two durations, as one op.
function PairDialog({
	kind,
	target,
	timing,
	run,
	onClose,
	hint
}: {
	kind: "trim" | "fade"
	target: ShapeRef
	timing: MediaTiming | undefined
	run: (op: DeckOp) => void
	onClose: () => void
	hint?: string
}) {
	const { t } = useTranslation("preview")
	const [first, setFirst] = useState(secondsText(kind === "trim" ? (timing?.trim?.startMs ?? 0) : (timing?.fade?.inMs ?? 0)))
	const [second, setSecond] = useState(secondsText(kind === "trim" ? (timing?.trim?.endMs ?? 0) : (timing?.fade?.outMs ?? 0)))
	const a = parseMediaSeconds(first)
	const b = parseMediaSeconds(second)
	const [submitted, setSubmitted] = useState(false)

	return (
		<FormDialog
			open
			pending={false}
			title={t(kind === "trim" ? "previewPptxMediaTrim" : "previewPptxMediaFade")}
			description={hint ?? t(kind === "trim" ? "previewPptxMediaTrimDescription" : "previewPptxMediaFadeDescription")}
			submitLabel={t("previewPptxObjectsApply")}
			cancelLabel={t("previewPptxInsertCancel")}
			canSubmit
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (a === undefined || b === undefined) {
					setSubmitted(true)

					return
				}

				const x = Math.round(a * 1000)
				const y = Math.round(b * 1000)

				run(
					kind === "trim"
						? { family: "mediaTiming", kind: "setTrim", target, startMs: x, endMs: y }
						: { family: "mediaTiming", kind: "setFade", target, inMs: x, outMs: y }
				)
				onClose()
			}}
		>
			<SecondsInput
				label={kind === "trim" ? "previewPptxMediaTrimStart" : "previewPptxMediaFadeIn"}
				value={first}
				onChange={setFirst}
				shown={submitted}
			/>
			<SecondsInput
				label={kind === "trim" ? "previewPptxMediaTrimEnd" : "previewPptxMediaFadeOut"}
				value={second}
				onChange={setSecond}
				shown={submitted}
			/>
		</FormDialog>
	)
}

// Add bookmark: a name and a time. Why it cannot be added shows by the field (on leaving it or submitting); a full list
// says so at once.
function BookmarkDialog({
	target,
	timing,
	run,
	onClose
}: {
	target: ShapeRef
	timing: MediaTiming | undefined
	run: (op: DeckOp) => void
	onClose: () => void
}) {
	const { t } = useTranslation("preview")
	const nameId = useId()
	const nameErrorId = useId()
	const taken = new Set([...(timing?.bookmarks?.map(bookmark => bookmark.name) ?? []), ...(timing?.unread ?? [])])
	let next = (timing?.bookmarks?.length ?? 0) + 1

	while (taken.has(t("previewPptxMediaBookmarkDefault", { count: next }))) next++

	const [name, setName] = useState<string>(t("previewPptxMediaBookmarkDefault", { count: next }))
	const [time, setTime] = useState("0")
	const [submitted, setSubmitted] = useState(false)
	const [nameLeft, setNameLeft] = useState(false)
	const seconds = parseMediaSeconds(time)
	const ms = seconds === undefined ? undefined : Math.round(seconds * 1000)
	const problem = bookmarkProblem(timing?.bookmarks, name, ms ?? 0, timing?.unread)
	const full = problem === "full"
	const nameMessage =
		problem === "name"
			? t("previewPptxMediaBookmarkNameInvalid")
			: problem === "duplicateName"
				? t("previewPptxMediaBookmarkNameTaken")
				: undefined
	const nameShown = nameMessage !== undefined && (submitted || nameLeft)

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewPptxMediaAddBookmark")}
			description={t("previewPptxMediaAddBookmarkDescription")}
			submitLabel={t("previewPptxMediaAddBookmark")}
			cancelLabel={t("previewPptxInsertCancel")}
			canSubmit={!full}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (ms === undefined || problem !== undefined) {
					setSubmitted(true)

					return
				}

				run({ family: "mediaTiming", kind: "addBookmark", target, name, timeMs: ms })
				onClose()
			}}
		>
			{full ? <FieldError>{t("previewPptxMediaBookmarksFull", { max: MEDIA_BOOKMARKS_MAX })}</FieldError> : null}
			<Field>
				<FieldLabel htmlFor={nameId}>{t("previewPptxMediaBookmarkName")}</FieldLabel>
				<Input
					id={nameId}
					value={name}
					maxLength={255}
					aria-invalid={nameShown}
					aria-describedby={nameShown ? nameErrorId : undefined}
					className="leading-5"
					onChange={event => {
						setName(event.target.value)
					}}
					onBlur={() => {
						setNameLeft(true)
					}}
				/>
				{nameShown ? <FieldError id={nameErrorId}>{nameMessage}</FieldError> : null}
			</Field>
			<SecondsInput
				label="previewPptxMediaBookmarkTime"
				value={time}
				onChange={setTime}
				shown={submitted}
				error={problem === "duplicateTime" ? t("previewPptxMediaBookmarkTimeTaken") : undefined}
			/>
		</FormDialog>
	)
}

function EditingControls({ editor, kind }: { editor: PresentationRibbonEditor; kind: MediaKind }) {
	const { t } = useTranslation("preview")
	const selected = useSelectedMedia(editor, kind)
	const dialog = useRibbonDialog(editor)
	const disabled = selected === undefined || !editor.info.editable
	const open = (which: "trim" | "fade"): void => {
		if (selected === undefined) return

		const { target, media } = selected

		dialog.open((live, close) => {
			const run = (op: DeckOp): void => {
				void live.command(op)
			}

			return which === "trim" ? (
				<TrimDialog
					session={live.session}
					media={media}
					target={target}
					run={run}
					onClose={close}
				/>
			) : (
				<PairDialog
					kind="fade"
					target={target}
					timing={media.timing}
					run={run}
					onClose={close}
				/>
			)
		})
	}

	return (
		<>
			<RibbonButton
				label={t("previewPptxMediaTrim")}
				text={t("previewPptxMediaTrim")}
				icon={<ScissorsIcon />}
				pressed={selected?.media.timing?.trim !== undefined}
				disabled={disabled}
				onClick={() => {
					open("trim")
				}}
			/>
			<RibbonButton
				label={t("previewPptxMediaFade")}
				text={t("previewPptxMediaFade")}
				icon={<AudioWaveformIcon />}
				pressed={selected?.media.timing?.fade !== undefined}
				disabled={disabled}
				onClick={() => {
					open("fade")
				}}
			/>
			{dialog.view}
		</>
	)
}

function BookmarkControls({ editor, kind }: { editor: PresentationRibbonEditor; kind: MediaKind }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const selected = useSelectedMedia(editor, kind)
	const dialog = useRibbonDialog(editor)
	const disabled = selected === undefined || !editor.info.editable
	const bookmarks = selected?.media.timing?.bookmarks ?? []

	return (
		<>
			<RibbonButton
				label={t("previewPptxMediaAddBookmark")}
				text={t("previewPptxMediaAddBookmark")}
				icon={<BookmarkPlusIcon />}
				disabled={disabled}
				onClick={() => {
					if (selected === undefined) return

					const { target, media } = selected

					dialog.open((live, close) => (
						<BookmarkDialog
							target={target}
							timing={media.timing}
							run={op => {
								void live.command(op)
							}}
							onClose={close}
						/>
					))
				}}
			/>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t("previewPptxMediaRemoveBookmark")}
					icon={<BookmarkMinusIcon />}
					disabled={disabled || bookmarks.length === 0}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
					className="max-h-80 min-w-48"
				>
					{bookmarks.length === 0 ? (
						<DropdownMenuItem disabled>{t("previewPptxMediaNoBookmarks")}</DropdownMenuItem>
					) : (
						bookmarks.map(bookmark => {
							// A bookmark an animation's trigger names stays until the trigger changes: its item says why.
							const used = selected?.media.triggered?.includes(bookmark.name) === true
							const label = t("previewPptxMediaBookmarkItem", { name: bookmark.name, time: secondsText(bookmark.timeMs) })

							return (
								<DropdownMenuItem
									key={bookmark.name}
									disabled={used}
									{...(used ? { "aria-label": `${label}: ${t("previewPptxMediaBookmarkUsed")}` } : {})}
									onClick={() => {
										focus.ran()

										if (selected === undefined || used) return

										void editor.command({
											family: "mediaTiming",
											kind: "removeBookmark",
											target: selected.target,
											name: bookmark.name
										})
									}}
								>
									<span className="flex flex-col">
										<span>{label}</span>
										{used ? (
											<span className="text-xs text-muted-foreground">{t("previewPptxMediaBookmarkUsed")}</span>
										) : null}
									</span>
								</DropdownMenuItem>
							)
						})
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{dialog.view}
		</>
	)
}

// A command OpenDocument has no form for: off, focusable, its reason in its name and tooltip (as SmartArt is).
function UnavailableButton({ label, icon }: { label: string; icon: ReactNode }) {
	const { t } = useTranslation("preview")
	const reason = t("previewPptxMediaUnavailableFormat")

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						disabled
						focusableWhenDisabled
						aria-label={`${label}: ${reason}`}
						className="shrink-0 gap-1 px-2"
						onMouseDown={keepFocus}
					>
						{icon}
						<span className="text-xs">{label}</span>
					</Button>
				}
			/>
			<TooltipContent>{reason}</TooltipContent>
		</Tooltip>
	)
}

function UnavailableControls({ group }: { group: "editing" | "bookmarks" }) {
	const { t } = useTranslation("preview")

	return group === "editing" ? (
		<>
			<UnavailableButton
				label={t("previewPptxMediaTrim")}
				icon={<ScissorsIcon />}
			/>
			<UnavailableButton
				label={t("previewPptxMediaFade")}
				icon={<AudioWaveformIcon />}
			/>
		</>
	) : (
		<>
			<UnavailableButton
				label={t("previewPptxMediaAddBookmark")}
				icon={<BookmarkPlusIcon />}
			/>
			<UnavailableButton
				label={t("previewPptxMediaRemoveBookmark")}
				icon={<BookmarkMinusIcon />}
			/>
		</>
	)
}

// The Editing and Bookmarks groups of the Video or Audio tab. OpenDocument has no trim, fade or bookmarks of a medium:
// there they show, off, with the reason.
export function mediaTimingGroups(kind: MediaKind, context: PresentationRibbonContext): ReturnType<PresentationGroups> {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	const odp = editor.info.format === "odp"

	return [
		{
			id: `${kind}Editing`,
			label: context.t("previewPptxMediaEditingGroup", { ns: "preview" }),
			icon: ScissorsIcon,
			width: 150,
			priority: 2,
			content: odp ? (
				<UnavailableControls group="editing" />
			) : (
				<EditingControls
					editor={editor}
					kind={kind}
				/>
			)
		},
		{
			id: `${kind}Bookmarks`,
			label: context.t("previewPptxMediaBookmarksGroup", { ns: "preview" }),
			icon: BookmarkIcon,
			width: 170,
			priority: 1,
			content: odp ? (
				<UnavailableControls group="bookmarks" />
			) : (
				<BookmarkControls
					editor={editor}
					kind={kind}
				/>
			)
		}
	]
}

// --- Animations ▸ Trigger: On Bookmark ---

const BOOKMARK_VALUE = "bookmark:"

// The trigger menu's value for a bookmark of the clip `shape`.
export function bookmarkTriggerValue(shape: number, bookmark: string): string {
	return `${BOOKMARK_VALUE}${String(shape)}:${bookmark}`
}

// The trigger a menu value names: a bookmark, else undefined (the menu's own values).
export function bookmarkTriggerOf(value: string): EffectTiming["trigger"] | undefined {
	if (!value.startsWith(BOOKMARK_VALUE)) return undefined

	const rest = value.slice(BOOKMARK_VALUE.length)
	const colon = rest.indexOf(":")
	const shape = Number(rest.slice(0, colon))

	return colon > 0 && Number.isSafeInteger(shape) ? { kind: "bookmark", shape, bookmark: rest.slice(colon + 1) } : undefined
}

// Each bookmark of each clip on the slide, by clip.
export function slideBookmarks(
	render: SlideRender | undefined
): { readonly shape: number; readonly bookmarks: readonly { readonly name: string }[] }[] {
	const out: { shape: number; bookmarks: readonly { readonly name: string }[] }[] = []

	for (const layer of render?.layers ?? []) {
		const bookmarks = layer.media?.timing?.bookmarks
		const shape = layer.box?.id

		if (bookmarks !== undefined && bookmarks.length > 0 && shape !== undefined && layer.shape.slide === render?.ref)
			out.push({ shape, bookmarks })
	}

	return out
}

// The Trigger menu's On Bookmark items (inside its radio group); nothing when no clip on the slide has a bookmark.
export function BookmarkTriggerItems({ render, name }: { render: SlideRender | undefined; name: (shape: number) => string }) {
	const { t } = useTranslation("preview")
	const clips = slideBookmarks(render)

	if (clips.length === 0) return null

	return (
		<DropdownMenuGroup>
			<DropdownMenuLabel>{t("previewPptxAnimTriggerBookmarks")}</DropdownMenuLabel>
			{clips.flatMap(clip =>
				clip.bookmarks.map(bookmark => (
					<DropdownMenuRadioItem
						key={bookmarkTriggerValue(clip.shape, bookmark.name)}
						value={bookmarkTriggerValue(clip.shape, bookmark.name)}
					>
						{t("previewPptxAnimTriggerBookmark", { bookmark: bookmark.name, name: name(clip.shape) })}
					</DropdownMenuRadioItem>
				))
			)}
		</DropdownMenuGroup>
	)
}
