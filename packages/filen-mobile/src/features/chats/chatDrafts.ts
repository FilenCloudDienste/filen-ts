// Per-chat draft keys in secure store. Kept free of heavy imports so the chat input components can
// use it without pulling in the inflight queue's store/sync graph.
export function chatInputValueKey(chatUuid: string): string {
	return `chatInputValue:${chatUuid}`
}

export function chatReplyToKey(chatUuid: string): string {
	return `chatReplyTo:${chatUuid}`
}

export function chatEditMessageKey(chatUuid: string): string {
	return `chatEditMessage:${chatUuid}`
}

export function chatDraftSecureStoreKeys(chatUuid: string): string[] {
	return [chatInputValueKey(chatUuid), chatReplyToKey(chatUuid), chatEditMessageKey(chatUuid)]
}
