import { type Chat } from "@/types"
import Avatar from "@/components/ui/avatar"

// No http avatar among the other participants shows the person fallback, even for groups.
export const ChatAvatar = ({
	participants,
	selfUserId,
	size,
	className
}: {
	participants: Chat["participants"]
	selfUserId: bigint | undefined
	size: number
	className?: string
}) => {
	const others = participants.filter(p => p.userId !== selfUserId)

	if (!others.some(p => p.avatar?.startsWith("http"))) {
		return (
			<Avatar
				className={className}
				size={size}
				immediateFallback={true}
			/>
		)
	}

	if (others.length <= 1) {
		return (
			<Avatar
				className={className}
				size={size}
				source={others.at(0)?.avatar}
			/>
		)
	}

	return (
		<Avatar
			className={className}
			size={size}
			group={others.length}
		/>
	)
}

export default ChatAvatar
