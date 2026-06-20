import Alert from "@blazejkustra/react-native-alert"
import { Semaphore, run } from "@filen/utils"
import { Platform } from "react-native"

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
	// When true, render only the OK button (an informational acknowledgement, no cancel).
	singleButton?: boolean
}

// Which button the user chose in a three-button alert (primary affirmative / destructive / cancel).
export type ThreeButtonPromptResult = "primary" | "destructive" | "cancel"

export type ThreeButtonPromptOptions = {
	title?: string
	message?: string
	primaryText: string
	destructiveText: string
	cancelText?: string
	cancellable?: boolean
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
					options?.singleButton
						? [
								{
									text: options?.okText ?? "OK",
									style: options?.destructive ? "destructive" : "default",
									onPress: () => {
										resolve({
											cancelled: false
										})
									}
								}
							]
						: [
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

	// Three-button alert: a primary (affirmative) action, a destructive action, and cancel.
	// Serialized through the same mutex as alert(). Button ORDER is platform-specific: Android maps
	// buttons by position to neutral(0)/negative(1)/positive(2), so the affirmative goes last to sit
	// on the right; iOS floats the cancel-style button to the bottom regardless and styles destructive
	// red, so the affirmative goes first. A dismiss (tap-outside / back) resolves to "cancel".
	async confirm3(options: ThreeButtonPromptOptions): Promise<ThreeButtonPromptResult> {
		const result = await run(async defer => {
			await promptsMutex.acquire()

			defer(() => {
				promptsMutex.release()
			})

			return await new Promise<ThreeButtonPromptResult>(resolve => {
				const primaryButton = {
					text: options.primaryText,
					style: "default" as const,
					onPress: () => {
						resolve("primary")
					}
				}

				const destructiveButton = {
					text: options.destructiveText,
					style: "destructive" as const,
					onPress: () => {
						resolve("destructive")
					}
				}

				const cancelButton = {
					text: options.cancelText ?? "Cancel",
					style: "cancel" as const,
					onPress: () => {
						resolve("cancel")
					}
				}

				Alert.alert(
					options.title ?? "Title",
					options.message,
					Platform.OS === "android"
						? [cancelButton, destructiveButton, primaryButton]
						: [primaryButton, destructiveButton, cancelButton],
					{
						cancelable: options.cancellable ?? true,
						onDismiss: () => {
							if (!(options.cancellable ?? true)) {
								return
							}

							resolve("cancel")
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
