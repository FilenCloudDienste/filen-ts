import * as TaskManager from "expo-task-manager"
import * as BackgroundTask from "expo-background-task"
import { BackgroundTaskResult, BackgroundTaskStatus } from "expo-background-task"
import { run } from "@filen/utils"
import setup from "@/lib/setup"
import cameraUpload from "@/lib/cameraUpload"

const TASK_NAME = "filen-camera-upload-sync"

TaskManager.defineTask(TASK_NAME, async () => {
	await run(async defer => {
		const expirationListener = BackgroundTask.addExpirationListener(() => {
			cameraUpload.cancel()
		})

		defer(() => {
			expirationListener.remove()
		})

		const { isAuthed } = await setup.setup({
			background: true
		})

		if (!isAuthed) {
			return
		}

		await cameraUpload.sync({
			maxUploads: 1,
			background: true
		})
	})

	return BackgroundTaskResult.Success
})

export async function registerBackgroundSync(): Promise<void> {
	try {
		const status = await BackgroundTask.getStatusAsync()

		if (status !== BackgroundTaskStatus.Available) {
			console.warn(`[BackgroundTask] Background sync not available: ${status}`)

			return
		}

		await BackgroundTask.registerTaskAsync(TASK_NAME, {
			minimumInterval: 15
		})

		console.log("[BackgroundTask] Registered background sync")
	} catch (e) {
		console.error("[BackgroundTask] Failed to register:", e)
	}
}

export async function unregisterBackgroundSync(): Promise<void> {
	try {
		const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME)

		if (!isRegistered) {
			return
		}

		await BackgroundTask.unregisterTaskAsync(TASK_NAME)

		console.log("[BackgroundTask] Unregistered background sync")
	} catch (e) {
		console.error("[BackgroundTask] Failed to unregister:", e)
	}
}
