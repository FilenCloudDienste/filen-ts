import { ContactEvent_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import { contactRequestsQueryUpdate } from "@/features/contacts/queries/useContactRequests.query"

export type ContactSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Contact }>

export async function handleContactEvent({ event }: { event: ContactSocketEvent }): Promise<void> {
	const [eventInner] = event.inner

	switch (eventInner.inner.tag) {
		case ContactEvent_Tags.ContactRequestReceived: {
			const [inner] = eventInner.inner.inner

			contactRequestsQueryUpdate({
				updater: prev => ({
					...prev,
					incoming: [
						...prev.incoming.filter(r => r.uuid !== inner.uuid),
						{
							uuid: inner.uuid,
							userId: inner.senderId,
							email: inner.senderEmail,
							avatar: inner.senderAvatar,
							nickName: inner.senderNickName
						}
					]
				})
			})

			break
		}

		default: {
			console.error(eventInner)

			throw new Error("Unhandled contact event")
		}
	}
}
