import { runAbortable } from "./run"

async function dev() {
	const controller = new AbortController()

	// Abort after 500ms
	setTimeout(() => controller.abort(), 500)

	const result = await runAbortable(
		async ({ abortable }) => {
			// This will be aborted mid-execution
			await abortable(async () => {
				console.log("Starting long operation...")
				await new Promise(resolve => setTimeout(resolve, 1000))
				console.log("This won't be logged if aborted")
			})

			return "completed"
		},
		{
			signal: controller.signal
		}
	)

	console.log(result)
}

dev()
