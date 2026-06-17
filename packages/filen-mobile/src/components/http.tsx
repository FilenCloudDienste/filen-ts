import { useSdkClients } from "@/lib/auth"
import type { JsClientInterface, HttpProviderHandle, AnyFile } from "@filen/sdk-rs"
import { type AppStateStatus, AppState } from "react-native"
import useEffectOnce from "@/hooks/useEffectOnce"
import { useEffect, useRef, useCallback } from "react"
import { runEffect, run, Semaphore } from "@filen/utils"
import useHttpStore from "@/stores/useHttp.store"
import alerts from "@/lib/alerts"
import { queryClient } from "@/queries/client"
import logger from "@/lib/logger"

const mutex = new Semaphore(1)

const InnerHttp = ({ sdkClient }: { sdkClient: JsClientInterface }) => {
	const httpHandleRef = useRef<HttpProviderHandle | null>(null)

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
						if (!httpHandleRef.current) {
							const handle = (await sdkClient.startHttpProvider(undefined)) as HttpProviderHandle

							useHttpStore.getState().setPort(handle.port())

							useHttpStore.getState().setGetFileUrl((file: AnyFile): string => {
								return handle.getFileUrl(file)
							})

							httpHandleRef.current = handle

							// Defense-in-depth: the instant the provider is ready, re-resolve every mounted
							// useFileUrlQuery so previews that resolved (or are waiting) during the boot window
							// pick up the live URL. The query has networkMode "always", so this isn't gated by
							// connectivity. Pairs with the readiness-wait in useFileUrl.query.ts.
							queryClient.invalidateQueries({
								queryKey: ["useFileUrlQuery"]
							})
						}

						break
					}

					case "background": {
						if (httpHandleRef.current) {
							httpHandleRef.current.uniffiDestroy()

							httpHandleRef.current = null

							useHttpStore.getState().setPort(null)
							useHttpStore.getState().setGetFileUrl(null)
						}

						break
					}
				}
			})

			if (!result.success) {
				logger.error("http", "HTTP provider lifecycle failed", { nextAppState, error: result.error })
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
				if (httpHandleRef.current) {
					httpHandleRef.current.uniffiDestroy()
					httpHandleRef.current = null
					useHttpStore.getState().setPort(null)
					useHttpStore.getState().setGetFileUrl(null)
				}
			})
		})

		return () => {
			cleanup()
		}
	}, [onAppStateChange])

	useEffectOnce(() => {
		// Mount ≠ foreground: an iOS cold background launch (BGProcessingTask) mounts the
		// tree with AppState "background" — starting the HTTP provider there holds a TCP
		// port for nothing during the background window. The AppState listener above
		// starts it on the real "active" transition instead.
		if (AppState.currentState === "active") {
			onAppStateChange("active").catch(e => logger.error("http", "HTTP provider failed on initial mount", { error: e }))
		}
	})

	return null
}

const Http = () => {
	const { authedSdkClient } = useSdkClients()

	if (!authedSdkClient) {
		return null
	}

	return <InnerHttp sdkClient={authedSdkClient} />
}

export default Http
