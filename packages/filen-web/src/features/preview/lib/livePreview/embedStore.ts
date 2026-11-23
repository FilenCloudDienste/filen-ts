import type { EmbedRenderer } from "@/features/preview/lib/livePreview/widgets"

// The live preview's embeds (formulas, diagrams) its widgets hold, for the host to portal into (livePreviewEmbeds.tsx):
// changed as the editor draws and drops widgets, announced once a task (a rebuild adds and drops many at once).

export interface Embed {
	readonly id: number
	readonly kind: "math" | "mermaid"
	readonly dom: HTMLElement
	readonly source: string
	readonly display: boolean
}

export class EmbedStore {
	private readonly entries = new Map<number, Embed>()
	private readonly listeners = new Set<() => void>()
	private snapshot: readonly Embed[] = []
	private next = 0
	private queued = false

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	readonly get = (): readonly Embed[] => this.snapshot

	// The widgets' renderer for one kind: registers the widget's element, and drops it on the widget's cleanup.
	renderer(kind: Embed["kind"]): EmbedRenderer {
		return (dom, source, display) => {
			const id = this.next++

			this.entries.set(id, { id, kind, dom, source, display })
			this.schedule()

			return () => {
				this.entries.delete(id)
				this.schedule()
			}
		}
	}

	private schedule(): void {
		if (this.queued) {
			return
		}

		this.queued = true
		queueMicrotask(() => {
			this.queued = false
			this.snapshot = [...this.entries.values()]

			for (const listener of this.listeners) {
				listener()
			}
		})
	}
}
