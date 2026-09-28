import { ListMusicIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { playlistArtworkGradient } from "@/features/audio/lib/playlistArtwork"

// Decorative: every surface showing it also shows the playlist's name as text. The cover, when one is
// known, paints over the gradient, so the tile never changes size or flashes empty while it loads.
export function PlaylistArtwork({
	uuid,
	coverUrl,
	className,
	iconClassName
}: {
	uuid: string
	coverUrl?: string | null
	className?: string
	iconClassName?: string
}) {
	return (
		<div
			aria-hidden="true"
			className={cn("relative flex shrink-0 items-center justify-center overflow-hidden text-white", className)}
			style={{ backgroundImage: playlistArtworkGradient(uuid) }}
		>
			<ListMusicIcon className={cn("opacity-90 drop-shadow-sm", iconClassName)} />
			{coverUrl ? (
				<img
					src={coverUrl}
					alt=""
					className="absolute inset-0 size-full object-cover"
				/>
			) : null}
		</div>
	)
}
