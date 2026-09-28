import { ListMusicIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { playlistArtworkGradient } from "@/features/audio/lib/playlistArtwork"

// Decorative: every surface showing it also shows the playlist's name as text.
export function PlaylistArtwork({ uuid, className, iconClassName }: { uuid: string; className?: string; iconClassName?: string }) {
	return (
		<div
			aria-hidden="true"
			className={cn("flex shrink-0 items-center justify-center text-white", className)}
			style={{ backgroundImage: playlistArtworkGradient(uuid) }}
		>
			<ListMusicIcon className={cn("opacity-90 drop-shadow-sm", iconClassName)} />
		</div>
	)
}
