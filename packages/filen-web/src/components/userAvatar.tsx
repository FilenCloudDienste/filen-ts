import { contactInitials } from "@/components/userAvatar.logic"
import { safeAvatarUrl } from "@/lib/avatarUrl"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

// Image and Fallback stay direct children of Avatar (its Base UI Root): Fallback only renders while no
// image has loaded (Base UI's own imageLoadingStatus gate). `src` is guarded here, the one sink: an SDK
// avatar field can carry a non-URL placeholder, which as an <img> source would be requested from the
// app's own origin before falling back to the initials.
export function UserAvatar({
	src,
	name,
	size,
	className,
	fallbackClassName,
	alt
}: {
	src: string | undefined
	name: string
	size?: "default" | "sm" | "lg"
	className?: string
	fallbackClassName?: string | undefined
	alt?: string
}) {
	const safeSrc = safeAvatarUrl(src)

	return (
		<Avatar
			size={size ?? "default"}
			className={className}
		>
			{/* crossOrigin: require-corp COEP needs a CORS-mode request for this cross-origin egest url — a
			    plain no-cors <img> would need a Cross-Origin-Resource-Policy response header the CDN doesn't
			    send (verified live against the sibling cdn.filen.io emoji host, which shares the same
			    Access-Control-Allow-Origin: * pattern). */}
			{safeSrc !== undefined ? (
				<AvatarImage
					src={safeSrc}
					alt={alt}
					crossOrigin="anonymous"
				/>
			) : null}
			<AvatarFallback className={fallbackClassName}>{contactInitials(name)}</AvatarFallback>
		</Avatar>
	)
}
