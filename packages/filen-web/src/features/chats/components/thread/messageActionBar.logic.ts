import type { MessageActionDescriptor, MessageActionId } from "@/features/chats/components/thread/messageMenu.logic"

// The quick-access inline icons the hover action bar surfaces — the direct, non-destructive actions worth
// one click. Destructive/low-frequency entries (delete/remove/block/
// disableEmbed) live only behind the ⋯ overflow. Reply/Copy/Edit are confirmed-only; Retry is failed-
// only, so at most three ever coexist.
export const INLINE_PRIMARY: readonly MessageActionId[] = ["reply", "copy", "edit", "retry"]

// The subset of a message's live descriptor list surfaced as inline icons, in INLINE_PRIMARY order — a
// pure projection of messageMenuActions, so a failed send surfaces Retry while a confirmed own message
// surfaces Reply/Copy/Edit. Always a subset of the input (the ⋯ overflow still opens the full menu).
export function inlinePrimaryActions(descriptors: readonly MessageActionDescriptor[]): MessageActionDescriptor[] {
	return INLINE_PRIMARY.flatMap(id => descriptors.filter(descriptor => descriptor.id === id))
}

// The keymap action (keymap.ts chats.message.*) behind each inline action, shown in its tooltip. Retry has no default
// keys; its tooltip shows the user's binding once they set one.
export const INLINE_ACTION_KEYMAP_IDS: Readonly<Partial<Record<MessageActionId, string>>> = {
	reply: "chats.message.reply",
	copy: "chats.message.copy",
	edit: "chats.message.edit",
	retry: "chats.message.retry"
}

// The ⋯ overflow's keys (Shift+F10 on the focused message).
export const MORE_ACTIONS_KEYMAP_ID = "chats.message.menu"
