import Alert from "@blazejkustra/react-native-alert"
import { Semaphore, run } from "@filen/utils"

export type AlertPromptResult =
	| {
			cancelled: true
	  }
	| {
			cancelled: false
	  }

export type AlertPromptOptions = {
	title?: string
	message?: string
	cancellable?: boolean
	okText?: string
	cancelText?: string
	destructive?: boolean
}

export type InputPromptResult =
	| {
			cancelled: true
	  }
	| {
			type: "string"
			cancelled: false
			value: string
	  }
	| {
			type: "credentials"
			cancelled: false
			login: string
			password: string
	  }

export type InputPromptOptions = {
	title?: string
	message?: string
	inputType?: "plain-text" | "secure-text"
	defaultValue?: string
	cancellable?: boolean
	okText?: string
	cancelText?: string
	placeholder?: string
	destructive?: boolean
}

// Serializes native dialogs (one at a time) so concurrent callers do not stack alerts.
const promptsMutex = new Semaphore(1)

const prompts = {
	async alert(options?: AlertPromptOptions): Promise<AlertPromptResult> {
		const result = await run(async defer => {
			await promptsMutex.acquire()

			defer(() => {
				promptsMutex.release()
			})

			return await new Promise<AlertPromptResult>(resolve => {
				Alert.alert(
					options?.title ?? "Title",
					options?.message,
					[
						{
							text: options?.cancelText ?? "Cancel",
							style: "cancel",
							onPress: () => {
								resolve({
									cancelled: true
								})
							}
						},
						{
							text: options?.okText ?? "OK",
							style: options?.destructive ? "destructive" : "default",
							onPress: () => {
								resolve({
									cancelled: false
								})
							}
						}
					],
					{
						cancelable: options?.cancellable ?? true,
						onDismiss: () => {
							if (!(options?.cancellable ?? true)) {
								return
							}

							resolve({
								cancelled: true
							})
						}
					}
				)
			})
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	},

	async info(options?: AlertPromptOptions): Promise<void> {
		const result = await run(async defer => {
			await promptsMutex.acquire()

			defer(() => {
				promptsMutex.release()
			})

			return await new Promise<void>(resolve => {
				Alert.alert(
					options?.title ?? "Title",
					options?.message,
					[
						{
							text: options?.okText ?? "OK",
							style: options?.destructive ? "destructive" : "default",
							onPress: () => {
								resolve()
							}
						}
					],
					{
						cancelable: options?.cancellable ?? true,
						onDismiss: () => {
							resolve()
						}
					}
				)
			})
		})

		if (!result.success) {
			throw result.error
		}
	},

	async input(options?: InputPromptOptions): Promise<InputPromptResult> {
		const result = await run(async defer => {
			await promptsMutex.acquire()

			defer(() => {
				promptsMutex.release()
			})

			return await new Promise<InputPromptResult>(resolve => {
				Alert.prompt(
					options?.title ?? "Title",
					options?.message,
					[
						{
							text: options?.cancelText ?? "Cancel",
							style: "cancel",
							onPress: () => {
								resolve({
									cancelled: true
								})
							}
						},
						{
							text: options?.okText ?? "OK",
							style: options?.destructive ? "destructive" : "default",
							onPress: (
								value?:
									| string
									| {
											login: string
											password: string
									  }
							) => {
								if (!value) {
									resolve({
										cancelled: false,
										value: "",
										type: "string"
									})

									return
								}

								if (typeof value === "string") {
									resolve({
										cancelled: false,
										type: "string",
										value
									})

									return
								}

								resolve({
									cancelled: false,
									type: "credentials",
									login: value.login,
									password: value.password
								})
							}
						}
					],
					options?.inputType ?? "plain-text",
					options?.defaultValue,
					undefined,
					{
						cancelable: options?.cancellable ?? true,
						onDismiss: () => {
							if (!(options?.cancellable ?? true)) {
								return
							}

							resolve({
								cancelled: true
							})
						}
					}
				)
			})
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}
}

export default prompts
