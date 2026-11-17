import { createContext, useContext, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { InfoIcon } from "lucide-react"
import type { DriveItem } from "@/features/drive/lib/item"
import { fileIconKey } from "@/features/drive/lib/icon.logic"
import { cachedOwnChain } from "@/features/drive/lib/ownAncestry"
import { startUploads } from "@/features/drive/lib/upload"
import { FileTypeIcon } from "@/features/drive/components/itemIcon"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { sniffedEntryCategory } from "@/features/archive/lib/entryAccess.logic"
import { useLinkSaveable } from "@/features/publicLinks/queries/publicLink"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewAccessMode, usePreviewDownloadable, useProvidedPreviewOrigin } from "@/features/preview/lib/accessMode"
import { embeddedFileItem } from "@/features/preview/lib/embeddedFileItem"
import { sanitizeEmailHtml } from "@/features/preview/lib/emailSanitizer"
import { readEmailFile } from "@/features/preview/lib/textFamilyClient"
import type { EmailAttachment, EmailMessage, EmailReading } from "@/features/preview/lib/emailReading"
import { NestedFileViewer } from "@/features/preview/components/nestedFileViewer"
import { SafeHtmlDocument } from "@/features/preview/components/safeHtmlDocument"
import { TextViewer } from "@/features/preview/components/textViewer"
import { PreviewErrorState, PreviewGate, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { bytesOrigin } from "@/lib/sdk/byteOrigin"
import { downloadBlob } from "@/lib/downloadBlob"
import { formatDateTime } from "@/lib/formatDate"
import { useIsOnline } from "@/lib/useIsOnline"
import { log } from "@/lib/log"
import { Button } from "@/components/ui/button"
import { cn } from "@filen/shared"

// Messages opened from a message's attachments, how deep: a forwarded message opens as one, three levels at most.
const EmailDepthContext = createContext(0)
const MAX_DEPTH = 3
// Recipients shown before "+N more".
const FOLDED_RECIPIENTS = 2

type ReadingState =
	{ status: "pending" } | { status: "done"; reading: EmailReading; cidUrls: ReadonlyMap<string, string> } | { status: "failed" }
type View = "html" | "text" | "source"

// The message's inline pictures (cid:) as object URLs for its HTML: raster images only, each a blob of the type its
// bytes say (the declared one never reaches a URL).
function mintCidUrls(attachments: readonly EmailAttachment[]): Map<string, string> {
	const made = new Map<string, string>()

	for (const attachment of attachments) {
		if (attachment.contentId !== null && attachment.imageType !== null && !made.has(attachment.contentId)) {
			made.set(attachment.contentId, URL.createObjectURL(new Blob([attachment.blob], { type: attachment.imageType })))
		}
	}

	return made
}

// The parse, with the object URLs of its inline pictures, revoked when the message goes.
function useEmailReading(bytes: Uint8Array): ReadingState {
	const [state, setState] = useState<ReadingState>({ status: "pending" })

	useEffect(() => {
		let live = true
		let minted: ReadonlyMap<string, string> = new Map()

		readEmailFile(bytes).then(
			reading => {
				if (!live) return

				minted = reading.status === "ok" ? mintCidUrls(reading.attachments) : new Map()
				setState({ status: "done", reading, cidUrls: minted })
			},
			(e: unknown) => {
				if (!live) return

				log.error("preview", "reading a message failed", e)
				setState({ status: "failed" })
			}
		)

		return () => {
			live = false

			for (const url of minted.values()) URL.revokeObjectURL(url)
		}
	}, [bytes])

	return state
}

function Recipients({ label, list }: { label: string; list: readonly string[] }) {
	const { t } = useTranslation("preview")
	const [open, setOpen] = useState(false)

	if (list.length === 0) {
		return null
	}

	const shown = open ? list : list.slice(0, FOLDED_RECIPIENTS)
	const hidden = list.length - shown.length

	return (
		<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
			<span className="w-10 shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 break-words">
				<bdi>{shown.join(", ")}</bdi>
			</span>
			{hidden > 0 || open ? (
				<Button
					variant="link"
					size="sm"
					className="h-auto p-0"
					onClick={() => {
						setOpen(!open)
					}}
				>
					{open ? t("previewEmailLess") : t("previewEmailMore", { count: hidden })}
				</Button>
			) : null}
		</div>
	)
}

function SaveToDrive({ item, attachment }: { item: DriveItem; attachment: EmailAttachment }) {
	const { t } = useTranslation(["preview", "common"])
	const isOnline = useIsOnline()
	const access = usePreviewAccessMode()
	const nested = useProvidedPreviewOrigin() !== null
	const [open, setOpen] = useState(false)

	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				disabled={!isOnline}
				title={isOnline ? undefined : t("common:offlineActionDisabled")}
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("previewEmailSaveToDrive")}
			</Button>
			{open ? (
				<MoveTargetDialog
					mode="pick"
					startsWork
					items={[]}
					// The message's own directory on the drive; the root for a link's or an archive's.
					initialPath={access === "authed" && !nested ? cachedOwnChain(item.data.parent) : undefined}
					pickLabels={{ title: t("previewEmailSaveTitle", { name: attachment.name }), confirm: t("previewEmailSaveConfirm") }}
					onPick={destination => {
						void startUploads([new File([attachment.blob], attachment.name, { type: attachment.blob.type })], destination.uuid)
					}}
					onClose={() => {
						setOpen(false)
					}}
				/>
			) : null}
		</>
	)
}

// A link's visitor may save only when signed in, the link not their own, downloads allowed (useLinkSaveable).
function LinkSaveGate({ item, attachment }: { item: DriveItem; attachment: EmailAttachment }) {
	const downloadable = usePreviewDownloadable()
	const saveable = useLinkSaveable("file", downloadable ? item.data.uuid : null)

	return saveable ? (
		<SaveToDrive
			item={item}
			attachment={attachment}
		/>
	) : null
}

function AttachmentRow({
	item,
	attachment,
	canOpen,
	onOpen
}: {
	item: DriveItem
	attachment: EmailAttachment
	canOpen: boolean
	onOpen: () => void
}) {
	const { t } = useTranslation("preview")
	const downloadable = usePreviewDownloadable()
	const access = usePreviewAccessMode()

	return (
		<li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
			<FileTypeIcon
				iconKey={fileIconKey(attachment.name, attachment.mimeType)}
				className="size-5 shrink-0"
			/>
			<span className="min-w-0 flex-1 truncate">
				<bdi>{attachment.name}</bdi>
			</span>
			<span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(attachment.size)}</span>
			<span className="flex shrink-0 gap-1">
				{canOpen ? (
					<Button
						variant="ghost"
						size="sm"
						onClick={onOpen}
					>
						{t("previewEmailOpen")}
					</Button>
				) : null}
				{downloadable ? (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							downloadBlob(attachment.name, attachment.blob)
						}}
					>
						{t("previewEmailDownload")}
					</Button>
				) : null}
				{access === "authed" ? (
					<SaveToDrive
						item={item}
						attachment={attachment}
					/>
				) : (
					<LinkSaveGate
						item={item}
						attachment={attachment}
					/>
				)}
			</span>
		</li>
	)
}

function attachmentItem(item: DriveItem, index: number, attachment: EmailAttachment): DriveItem {
	return embeddedFileItem(`${item.data.uuid}#att${String(index)}`, attachment.name, attachment.size, Number.NaN)
}

// A forwarded or embedded message, which opens as a message one level deeper.
function isMessageAttachment(attachment: EmailAttachment): boolean {
	const name = attachment.name.toLowerCase()

	return (
		attachment.mimeType === "message/rfc822" ||
		attachment.mimeType === "application/vnd.ms-outlook" ||
		name.endsWith(".eml") ||
		name.endsWith(".msg")
	)
}

function ViewSwitch({
	view,
	onView,
	hasHtml,
	hasText,
	hasSource
}: {
	view: View
	onView: (view: View) => void
	hasHtml: boolean
	hasText: boolean
	hasSource: boolean
}) {
	const { t } = useTranslation("preview")
	const options: { view: View; label: string; enabled: boolean }[] = [
		{ view: "html", label: t("previewEmailViewHtml"), enabled: hasHtml },
		{ view: "text", label: t("previewEmailViewText"), enabled: hasText },
		// A binary file (.msg) has no source to show.
		...(hasSource ? [{ view: "source" as const, label: t("previewEmailViewSource"), enabled: true }] : [])
	]

	return (
		<div
			role="group"
			aria-label={t("previewEmailView")}
			className="flex shrink-0 rounded-md border border-border p-0.5"
		>
			{options.map(option => (
				<Button
					key={option.view}
					variant="ghost"
					size="sm"
					aria-pressed={view === option.view}
					disabled={!option.enabled}
					className={cn("h-7 px-2 text-xs", view === option.view ? "bg-accent text-foreground" : null)}
					onClick={() => {
						onView(option.view)
					}}
				>
					{option.label}
				</Button>
			))}
		</div>
	)
}

function HtmlBody({ html, cidUrls, title }: { html: string; cidUrls: ReadonlyMap<string, string>; title: string }) {
	const { t } = useTranslation("preview")
	// Sanitized once per message and set of parts (the compiler keeps it).
	const sanitized = sanitizeEmailHtml(html, id => cidUrls.get(id) ?? null)

	return (
		<div className="flex size-full flex-col">
			{sanitized.remoteBlocked > 0 ? (
				<p className="flex items-center gap-2 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
					<InfoIcon className="size-4 shrink-0" />
					{t("previewEmailRemoteBlocked", { count: sanitized.remoteBlocked })}
				</p>
			) : null}
			<div className="min-h-0 flex-1">
				<SafeHtmlDocument
					html={sanitized.html}
					links={sanitized.links}
					title={title}
					layout="fill"
					paper
				/>
			</div>
		</div>
	)
}

function MessageView({ item, message, cidUrls }: { item: DriveItem; message: EmailMessage; cidUrls: ReadonlyMap<string, string> }) {
	const { t } = useTranslation("preview")
	const depth = useContext(EmailDepthContext)
	const downloadable = usePreviewDownloadable()
	const hasHtml = message.html !== null && message.html.trim() !== ""
	const hasText = message.text !== null && message.text.trim() !== ""
	const [view, setView] = useState<View>(hasHtml ? "html" : "text")
	const [opened, setOpened] = useState<number | null>(null)
	const title = message.subject ?? t("previewEmailNoSubject")
	const listed = message.attachments.map((attachment, index) => ({ attachment, index })).filter(({ attachment }) => !attachment.inline)
	const date =
		message.date === null ? null : Number.isNaN(Date.parse(message.date)) ? message.date : formatDateTime(Date.parse(message.date))
	const openedAttachment = opened === null ? undefined : message.attachments[opened]

	if (opened !== null && openedAttachment !== undefined) {
		const nested = attachmentItem(item, opened, openedAttachment)

		return (
			<EmailDepthContext value={depth + 1}>
				<NestedFileViewer
					item={nested}
					origin={bytesOrigin(openedAttachment.blob, nested.data.uuid)}
					category={null}
					references={null}
					backLabel={t("previewEmailBack")}
					onBack={() => {
						setOpened(null)
					}}
					onDownload={
						downloadable
							? () => {
									downloadBlob(openedAttachment.name, openedAttachment.blob)
								}
							: null
					}
				/>
			</EmailDepthContext>
		)
	}

	return (
		<div className="flex size-full flex-col overflow-hidden">
			<header className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-3">
				<div className="flex min-w-0 items-start justify-between gap-3">
					<h2 className="min-w-0 text-base font-semibold break-words">
						<bdi>{title}</bdi>
					</h2>
					<ViewSwitch
						view={view}
						onView={setView}
						hasHtml={hasHtml}
						hasText={hasText}
						hasSource={message.hasSource}
					/>
				</div>
				<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-sm">
					<span className="flex min-w-0 gap-2">
						<span className="w-10 shrink-0 text-muted-foreground">{t("previewEmailFrom")}</span>
						<bdi className="min-w-0 break-words">{message.from ?? ""}</bdi>
					</span>
					{date === null ? null : <span className="shrink-0 text-muted-foreground">{date}</span>}
				</div>
				<Recipients
					label={t("previewEmailTo")}
					list={message.to}
				/>
				<Recipients
					label={t("previewEmailCc")}
					list={message.cc}
				/>
				{message.addressesOmitted > 0 ? (
					<p className="text-xs text-muted-foreground">
						{t("previewEmailAddressesOmitted", { count: message.addressesOmitted })}
					</p>
				) : null}
			</header>
			<div className="min-h-0 flex-1">
				{view === "source" && message.hasSource ? (
					<TextViewer
						item={item}
						alt={title}
					/>
				) : view === "html" && hasHtml ? (
					<HtmlBody
						html={message.html}
						cidUrls={cidUrls}
						title={title}
					/>
				) : hasText ? (
					<pre className="size-full overflow-auto p-4 font-sans text-sm break-words whitespace-pre-wrap select-text">
						<bdi>{message.text}</bdi>
					</pre>
				) : (
					<p className="p-4 text-sm text-muted-foreground">{t("previewEmailNoBody")}</p>
				)}
			</div>
			{listed.length === 0 ? null : (
				<section className="max-h-[40%] shrink-0 overflow-y-auto border-t border-border">
					<h3 className="px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
						{t("previewEmailAttachments", { count: listed.length })}
					</h3>
					<ul className="pb-2">
						{listed.map(({ attachment, index }) => {
							const nested = attachmentItem(item, index, attachment)
							const forwarded = isMessageAttachment(attachment)

							return (
								<AttachmentRow
									key={index}
									item={item}
									attachment={attachment}
									canOpen={sniffedEntryCategory(nested) !== null && !(forwarded && depth + 1 >= MAX_DEPTH)}
									onOpen={() => {
										setOpened(index)
									}}
								/>
							)
						})}
					</ul>
				</section>
			)}
		</div>
	)
}

function EmailView({ item, bytes }: { item: DriveItem; bytes: Uint8Array }) {
	const { t } = useTranslation("preview")
	const state = useEmailReading(bytes)

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	if (state.status === "failed") {
		return <PreviewErrorState message={t("previewEmailFailed")} />
	}

	if (state.reading.status !== "ok") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewEmailTooLarge")}
			/>
		)
	}

	return (
		<MessageView
			item={item}
			message={state.reading}
			cidUrls={state.cidUrls}
		/>
	)
}

// An e-mail message (E1): subject, sender, date and recipients; its HTML body in a script-less frame with nothing remote
// loaded and its links listed beside it, or its text, or (an .eml's) its source, read-only; its attachments to open here (through
// NestedFileViewer, from the Blob the parse made), download or save to the drive.
export function EmailViewer({ item }: { item: DriveItem }) {
	const result = usePreviewBytes(item)

	return (
		<PreviewGate result={result}>
			{ready => (
				<EmailView
					item={item}
					bytes={ready.bytes}
				/>
			)}
		</PreviewGate>
	)
}
