// Minimal SDK socket-event envelope matching the handlers' destructure:
//   const [eventInner] = event.inner
//   eventInner.inner.tag  → <Domain>Event_Tags.*
//   const [inner] = eventInner.inner.inner
export function socketEvent<T>(socketTag: string, eventTag: string, payload: unknown): T {
	return {
		tag: socketTag,
		inner: [{ inner: { tag: eventTag, inner: [payload] } }]
	} as unknown as T
}
