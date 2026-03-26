import { useSdkClients } from "@/lib/auth"
import type { JsClientInterface, HttpProviderHandle, AnyFile } from "@filen/sdk-rs"
import { type AppStateStatus, AppState } from "react-native"
import useEffectOnce from "@/hooks/useEffectOnce"
import { useEffect, useRef, memo, useCallback } from "react"
import { runEffect, run, Semaphore } from "@filen/utils"
import useHttpStore from "@/stores/useHttp.store"
import alerts from "@/lib/alerts"

const mutex = new Semaphore(1)

const InnerHttp = memo(({ sdkClient }: { sdkClient: JsClientInterface }) => {
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
				console.error(result.error)
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
		})

		return () => {
			cleanup()
		}
	}, [onAppStateChange])

	useEffectOnce(() => {
		onAppStateChange("active").catch(console.error)
	})

	return null
})

const Http = memo(() => {
	const { authedSdkClient } = useSdkClients()

	if (!authedSdkClient) {
		return null
	}

	return <InnerHttp sdkClient={authedSdkClient} />
})

export default Http
