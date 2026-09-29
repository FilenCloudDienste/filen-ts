import type { EmbedCandidate } from "@/features/chats/lib/embeds.logic"
import { useChatMessageLinksQuery } from "@/features/chats/queries/chatMessageLinks"
import { FilenLinkCard } from "@/features/chats/components/thread/embeds/filenLinkCard"

// Filen public-link cards — one per unique link (embeds.logic.ts's cap + dedup), stacked under the
// message text (messageRow.tsx mounts this directly below MessageContent and derives `candidates`, empty
// when the sender disabled embeds). The plain link inline in the text is untouched either way, this
// component only ever ADDS chrome on top of it, never replaces it, so a failed/disabled/loading embed
// silently degrades to that plain link.
export function MessageEmbeds({ candidates }: { candidates: EmbedCandidate[] }) {
	const linksQuery = useChatMessageLinksQuery(candidates.map(candidate => candidate.url))

	if (candidates.length === 0) {
		return null
	}

	return (
		<div className="mt-0.5 flex flex-col gap-1.5">
			{candidates.map(candidate => (
				<FilenLinkCard
					key={candidate.url}
					url={candidate.url}
					link={candidate.link}
					resolution={linksQuery.data?.find(result => result.url === candidate.url)}
				/>
			))}
		</div>
	)
}
