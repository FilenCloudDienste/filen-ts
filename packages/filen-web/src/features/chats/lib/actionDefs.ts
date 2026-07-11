import { PencilIcon, Volume2Icon, VolumeOffIcon, UsersIcon, MailOpenIcon, Trash2Icon, LogOutIcon, type LucideIcon } from "lucide-react"
import { type ChatsKey } from "@/lib/i18n"

export interface ChatActionDef {
	labelKey: ChatsKey
	icon: LucideIcon
	destructive?: boolean
}

// Per-action label + icon (+ destructive styling) facts for the chat menu (chatMenu.logic.ts), mirroring
// notes' own NOTE_ACTION_DEFS split: one place a label/icon can drift from, gating/ordering stays the
// builder's own concern. Mute is two entries — the builder picks by the chat's current flag, same as
// notes' pin/favorite.
export const CHAT_ACTION_DEFS = {
	markRead: { labelKey: "chatActionMarkRead", icon: MailOpenIcon },
	mute: { labelKey: "chatActionMute", icon: VolumeOffIcon },
	unmute: { labelKey: "chatActionUnmute", icon: Volume2Icon },
	participants: { labelKey: "chatActionParticipants", icon: UsersIcon },
	rename: { labelKey: "chatActionRename", icon: PencilIcon },
	delete: { labelKey: "chatActionDelete", icon: Trash2Icon, destructive: true },
	leave: { labelKey: "chatActionLeave", icon: LogOutIcon, destructive: true }
} satisfies Record<string, ChatActionDef>
