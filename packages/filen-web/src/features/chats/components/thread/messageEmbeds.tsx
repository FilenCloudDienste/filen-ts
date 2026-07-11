import { extractMessageLinks, embedCandidatesForLinks } from "@/features/chats/lib/embeds.logic"
import { useChatMessageLinksQuery } from "@/features/chats/queries/chatMessageLinks"
import { FilenLinkCard } from "@/features/chats/components/thread/embeds/filenLinkCard"
import { MediaEmbed } from "@/features/chats/components/thread/embeds/mediaEmbed"

// Embed rendering — one per unique in-scope URL (embeds.logic.ts's cap + dedup), stacked under the
// message text (messageRow.tsx mounts this directly below MessageContent). `embedDisabled` (the sender's
// own disableMessageEmbed toggle, socket-synced) short-circuits to nothing rendered at all — the plain
// link inline in the text is untouched either way, this component only ever ADDS chrome on top of it,
// never replaces it, so a failed/disabled/loading embed silently degrades to that plain link.
export function MessageEmbeds({ text, embedDisabled }: { text: string | undefined; embedDisabled: boolean }) {
	const candidates = embedDisabled ? [] : embedCandidatesForLinks(extractMessageLinks(text))
	const linksQuery = useChatMessageLinksQuery(candidates.map(candidate => candidate.url))

	if (candidates.length === 0) {
		return null
	}

	return (
		<div className="mt-0.5 flex flex-col gap-1.5">
			{candidates.map(candidate => {
				const resolution = linksQuery.data?.find(result => result.url === candidate.url)

				return candidate.kind === "filenLink" ? (
					<FilenLinkCard
						key={candidate.url}
						url={candidate.url}
						link={candidate.link}
						resolution={resolution}
					/>
				) : (
					<MediaEmbed
						key={candidate.url}
						url={candidate.url}
						category={candidate.category}
						resolution={resolution}
					/>
				)
			})}
		</div>
	)
}
