import Alert from "@blazejkustra/react-native-alert"
import { Semaphore, run } from "@filen/shared"
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
	// See ThreeButtonPromptOptions.gate.
	gate?: PromptGate
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
	// A condition the alert shows under only (an alert that must not draw over the biometric lock waits for
	// the unlock). Waited for without holding the prompts queue, so the lock's own PIN prompt is never stuck
	// behind it, and checked again once the alert's turn comes, as the app can lock while it waits.
	gate?: PromptGate
}

export type PromptGate = {
	isOpen: () => boolean
	whenOpen: () => Promise<void>
}

export type InputPromptResult =
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			value: string
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
	/**
	 * Field semantics for the keyboard. A plain-text prompt otherwise capitalizes the first letter,
	 * which is right for the names these prompts mostly collect and wrong for an address — so an
	 * address says so, and gets the address keyboard on both platforms into the bargain.
	 */
	keyboardType?: "default" | "email-address"
}

// Serializes native dialogs (one at a time) so concurrent callers do not stack alerts.
const promptsMutex = new Semaphore(1)

// Takes the prompts queue for an alert, with its gate open. The queue is never held while the gate is
// closed: waiting for the gate first, and letting the queue go again if it closed meanwhile.
async function acquireOpen(gate: PromptGate | undefined): Promise<void> {
	for (;;) {
		if (gate !== undefined && !gate.isOpen()) {
			await gate.whenOpen()
		}

		await promptsMutex.acquire()

		if (gate === undefined || gate.isOpen()) {
			return
		}

		promptsMutex.release()
	}
}

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
			await acquireOpen(options.gate)

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
			await acquireOpen(options?.gate)

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
								// Only login-password prompts hand back an object, and none is ever requested.
								resolve({
									cancelled: false,
									value: typeof value === "string" ? value : ""
								})
							}
						}
					],
					options?.inputType ?? "plain-text",
					options?.defaultValue,
					options?.keyboardType,
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
