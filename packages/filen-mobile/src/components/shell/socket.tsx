import auth, { useSdkClients, useStringifiedClient } from "@/lib/auth"
import { type JsClientInterface, SocketEvent_Tags, ListenerHandle, GeneralEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import { useEffect, useRef, useCallback } from "react"
import { runEffect, run, Semaphore } from "@filen/utils"
import useChatsStore from "@/features/chats/store/useChats.store"
import useSocketStore, { type State as SocketState } from "@/stores/useSocket.store"
import alerts from "@/lib/alerts"
import { AppState, type AppStateStatus } from "react-native"
import useEffectOnce from "@/hooks/useEffectOnce"
import chats from "@/features/chats/chats"
import { handleNoteEvent } from "@/features/notes/socketHandlers"
import { handleChatEvent, chatTypingTimeoutsRef } from "@/features/chats/socketHandlers"
import { handleDriveEvent } from "@/features/drive/socketHandlers"
import { handleContactEvent } from "@/features/contacts/socketHandlers"
import logger from "@/lib/logger"

type ConnectionTag =
	| SocketEvent_Tags.Reconnecting
	| SocketEvent_Tags.AuthSuccess
	| SocketEvent_Tags.AuthFailed
	| SocketEvent_Tags.Unsubscribed

/**
 * Pure mapping from a connection-lifecycle socket event tag to the corresponding
 * UI socket state. Exported so that tests can exercise the real production mapping.
 */
export function socketEventTagToState(tag: ConnectionTag): SocketState {
	return tag === SocketEvent_Tags.Reconnecting
		? "reconnecting"
		: tag === SocketEvent_Tags.AuthSuccess
			? "connected"
			: "disconnected"
}

async function onEvent({ event, userId }: { event: SocketEvent; userId: bigint }) {
	try {
		switch (event.tag) {
			case SocketEvent_Tags.Reconnecting:
			case SocketEvent_Tags.AuthSuccess:
			case SocketEvent_Tags.AuthFailed:
			case SocketEvent_Tags.Unsubscribed: {
				for (const timeout of Object.values(chatTypingTimeoutsRef)) {
					clearTimeout(timeout)
				}

				useChatsStore.getState().setTyping({})

				useSocketStore.getState().setState(socketEventTagToState(event.tag))

				logger.info("socket", "connection state changed", { tag: event.tag })

				if (event.tag === SocketEvent_Tags.AuthSuccess) {
					// Refetch chats and messages to ensure we have the latest data after reconnect + to update unread counts
					chats.refetchChatsAndMessages().catch(e => logger.error("socket", "chats refetch after reconnect failed", { error: e }))
				}

				break
			}

			case SocketEvent_Tags.General: {
				const [eventInner] = event.inner

				switch (eventInner.inner.tag) {
					case GeneralEvent_Tags.PasswordChanged: {
						auth.logout().catch(e => logger.error("socket", "logout after PasswordChanged failed", { error: e }))

						break
					}

					case GeneralEvent_Tags.NewEvent: {
						// Noop

						break
					}

					default: {
						logger.error("socket", "Unhandled general event", { tag: (eventInner as { inner?: { tag?: string } }).inner?.tag })

						throw new Error("Unhandled general event")
					}
				}

				break
			}

			case SocketEvent_Tags.Drive: {
				await handleDriveEvent({ event })

				break
			}

			case SocketEvent_Tags.Chat: {
				await handleChatEvent({ event, userId })

				break
			}

			case SocketEvent_Tags.Note: {
				await handleNoteEvent({ event })

				break
			}

			case SocketEvent_Tags.Contact: {
				await handleContactEvent({ event })

				break
			}

			default: {
				logger.error("socket", "Unhandled socket event", { tag: (event as { tag?: string }).tag })

				throw new Error("Unhandled event")
			}
		}
	} catch (e) {
		logger.error("socket", "onEvent failed", { eventTag: event.tag, error: e })
		alerts.error(e)
	}
}

const mutex = new Semaphore(1)

const InnerSocket = ({ sdkClient }: { sdkClient: JsClientInterface }) => {
	const socketListenerHandleRef = useRef<ListenerHandle | null>(null)
	const stringifiedClient = useStringifiedClient()
	const stringifiedClientRef = useRef(stringifiedClient)

	useEffect(() => {
		stringifiedClientRef.current = stringifiedClient
	}, [stringifiedClient])

	const onAppStateChange = useCallback(
		async (nextAppState: AppStateStatus) => {
			if (nextAppState !== "active" && nextAppState !== "background") {
				return
			}

			const result = await run(async defer => {
				await mutex.acquire()

				defer(() => {
					mutex.release()
				})

				switch (nextAppState) {
					case "active": {
						if (!socketListenerHandleRef.current) {
							socketListenerHandleRef.current = (await sdkClient.addEventListener(
								{
									onEvent: event => {
										const client = stringifiedClientRef.current

										onEvent({
											event,
											userId: client ? client.userId : BigInt(0)
										}).catch(e => logger.error("socket", "onEvent threw outside try/catch", { error: e }))
									}
								},
								undefined
							)) as ListenerHandle

							// Seed initial state from SDK once on listener registration;
							// ongoing state is driven purely by SocketEvent_Tags events.
							if (sdkClient.isSocketConnected()) {
								useSocketStore.getState().setState("connected")
							}
						}

						break
					}

					case "background": {
						if (socketListenerHandleRef.current) {
							socketListenerHandleRef.current.uniffiDestroy()

							socketListenerHandleRef.current = null

							useSocketStore.getState().setState("disconnected")
						}

						break
					}
				}
			})

			if (!result.success) {
				logger.error("socket", "appState transition failed", { nextAppState, error: result.error })
				alerts.error(result.error)

				return
			}
		},
		[sdkClient]
	)

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const appStateSubscription = AppState.addEventListener("change", onAppStateChange)

			defer(() => {
				appStateSubscription.remove()
			})

			defer(() => {
				// Take the mutex like every other transition (mirrors http.tsx's unmount teardown): if
				// unmount (logout flips isAuthed) lands while an "active" transition is mid-flight —
				// holding the mutex, awaiting sdkClient.addEventListener — a synchronous check here would
				// see a null ref, skip, and then the resumed handler would assign the ref and leave that
				// ListenerHandle undestroyed with onEvent live during the logout wipe. Serializing makes
				// the in-flight registration complete first, so this reliably destroys it.
				run(async innerDefer => {
					await mutex.acquire()

					innerDefer(() => {
						mutex.release()
					})

					if (socketListenerHandleRef.current) {
						socketListenerHandleRef.current.uniffiDestroy()
						socketListenerHandleRef.current = null
						useSocketStore.getState().setState("disconnected")
					}
				}).then(result => {
					if (!result.success) {
						logger.error("socket", "socket unmount teardown failed", { error: result.error })
					}
				})
			})
		})

		return () => {
			cleanup()
		}
	}, [onAppStateChange])

	useEffectOnce(() => {
		// Mount ≠ foreground: an iOS cold background launch (BGProcessingTask) mounts the
		// tree with AppState "background" — connecting the socket there would burn the
		// background run's budget on event traffic. When mount happens before "active"
		// (cold launch pre-becomeActive, or a background launch), the AppState listener
		// registered above handles the real transition instead.
		if (AppState.currentState === "active") {
			onAppStateChange("active").catch(e => logger.error("socket", "initial socket connect failed", { error: e }))
		}
	})

	return null
}

const Socket = () => {
	const { authedSdkClient } = useSdkClients()

	if (!authedSdkClient) {
		return null
	}

	return <InnerSocket sdkClient={authedSdkClient} />
}

export default Socket
