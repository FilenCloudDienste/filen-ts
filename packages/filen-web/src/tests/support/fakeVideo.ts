// A <video> stand-in for playback session tests under node: the properties and events the sessions and
// watchdogs read, driven by the test.
export class FakeVideo extends EventTarget {
	public readonly HAVE_NOTHING = 0
	public readonly HAVE_METADATA = 1
	public readonly HAVE_CURRENT_DATA = 2
	public readonly HAVE_FUTURE_DATA = 3
	public readonly HAVE_ENOUGH_DATA = 4
	public paused = true
	public loop = false
	public seeking = false
	public readyState = 0
	public currentTime = 0
	public videoWidth = 0
	public videoHeight = 0
	public disableRemotePlayback = false
	public error: { code: number; message: string } | null = null
	public buffered = { length: 0, start: (): number => 0, end: (): number => 0 }
	public src = ""
	public loads = 0
	public plays = 0
	public readonly frameCallbacks: (() => void)[] = []
	private readonly attributes = new Map<string, string>()

	public get poster(): string {
		return this.attributes.get("poster") ?? ""
	}

	public set poster(value: string) {
		this.attributes.set("poster", value)
	}

	public getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null
	}

	public setAttribute(name: string, value: string): void {
		this.attributes.set(name, value)
	}

	public removeAttribute(name: string): void {
		if (name === "src") {
			this.src = ""
		}

		this.attributes.delete(name)
	}

	// As the media element load algorithm: everything resets, and a playing element pauses (the event is
	// queued, so it lands after the caller's own code).
	public load(): void {
		this.loads++
		this.readyState = 0
		this.error = null

		if (!this.paused) {
			this.paused = true
			queueMicrotask(() => {
				this.emit("pause")
			})
		}

		this.emit("emptied")
	}

	public play(): Promise<void> {
		this.plays++

		if (this.paused) {
			this.paused = false
			this.emit("play")
		}

		return Promise.resolve()
	}

	public pause(): void {
		if (!this.paused) {
			this.paused = true
			this.emit("pause")
		}
	}

	public requestVideoFrameCallback(callback: () => void): number {
		this.frameCallbacks.push(callback)

		return this.frameCallbacks.length
	}

	public cancelVideoFrameCallback(): void {
		this.frameCallbacks.length = 0
	}

	public emit(type: string): void {
		this.dispatchEvent(new Event(type))
	}

	public loadMetadata(): void {
		this.readyState = this.HAVE_METADATA
		this.emit("loadedmetadata")
	}

	public canPlay(): void {
		this.readyState = this.HAVE_ENOUGH_DATA
		this.emit("canplay")
	}

	public fail(code: number): void {
		this.error = { code, message: "" }
		this.emit("error")
	}

	public asElement(): HTMLVideoElement {
		return this as unknown as HTMLVideoElement
	}
}
