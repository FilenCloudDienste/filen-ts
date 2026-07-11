import { useTranslation } from "react-i18next"
import { FileIcon, FolderIcon } from "lucide-react"
import type { FilenPublicLink } from "@/features/chats/lib/embeds.logic"
import type { ChatLinkResolution } from "@/features/chats/queries/chatMessageLinks"

// Compact card for a Filen public link (file or directory) pasted into a message — the same category
// old-web rendered as a same-origin viewer iframe, deferred here
// to a plain card (no public-link VIEWER exists on this web build yet — that's a drive-feature surface,
// out of scope for a chat embed). Clicking opens the link itself in a new tab, same as any other
// auto-linked URL — this is chrome around the existing plain-link affordance, not a replacement for it.
//
// `resolution` is undefined while the metadata read is in flight, or when the caller never queried
// (e.g. a test rendering the card in isolation) — either way the card degrades to the bare uuid, never
// blocking on the network read to show SOMETHING.
export function FilenLinkCard({
	url,
	link,
	resolution
}: {
	url: string
	link: FilenPublicLink
	resolution: ChatLinkResolution | undefined
}) {
	const { t } = useTranslation("chats")
	const Icon = link.kind === "directory" ? FolderIcon : FileIcon
	const resolvedName = resolution?.kind === "filenLink" && resolution.success ? resolution.data.name : null
	const name = resolvedName ?? link.linkUuid

	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer nofollow"
			className="mt-1 flex max-w-sm min-w-0 items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm transition-colors hover:bg-muted/70"
		>
			<Icon
				aria-hidden="true"
				className="size-5 shrink-0 text-muted-foreground"
			/>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-foreground">{name}</span>
				<span className="truncate text-xs text-muted-foreground">
					{t(link.kind === "directory" ? "chatEmbedFilenDirectory" : "chatEmbedFilenFile")}
				</span>
			</span>
		</a>
	)
}
