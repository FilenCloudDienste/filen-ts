import type { Transition } from "../../../../core/anim/model"
import type { SlideRef } from "../../../../core/presentation/model"
import { WEBGL_TRANSITION_KINDS } from "../../../../core/anim/morph"
import { GlDevice, hasWebgl2, type ProgramName } from "./device"
import { drawsMorph, prepareMorph, releaseMorph, startMorph, type MorphData } from "./morph"
import { drawsParticle, particleShape, startParticles } from "./particles"
import type {
	ShowTransitionContext,
	ShowTransitionPrepared,
	ShowTransitionRenderer,
	ShowTransitionRequest,
	ShowTransitionRun
} from "./types"

// The show's WebGL2 transitions: the p14 particle set and morph. A transition is prepared with the slide it enters
// (the context made and its programs compiled, and for morph both slides' objects drawn), so a run's start only
// composes or places and its frames only draw. Without WebGL2, when a context cannot be made, after the browser
// loses it, or when the stage cannot be drawn exactly, it declines and the player plays the file's own mc:Fallback.

export type {
	ShowTransitionContext,
	ShowTransitionPrepared,
	ShowTransitionRenderer,
	ShowTransitionRequest,
	ShowTransitionRun
} from "./types"

class Prepared implements ShowTransitionPrepared {
	readonly outgoing: SlideRef | undefined
	readonly device: GlDevice
	readonly morph: MorphData | undefined
	private released = false

	constructor(outgoing: SlideRef | undefined, device: GlDevice, morph: MorphData | undefined) {
		this.outgoing = outgoing
		this.device = device
		this.morph = morph
	}

	get bytes(): number {
		return this.released ? 0 : (this.morph?.bytes ?? 0)
	}

	release(): void {
		if (this.released) return

		this.released = true

		if (this.morph !== undefined && !this.device.lost) releaseMorph(this.device, this.morph)

		this.device.release()
	}
}

function draws(kind: string, namespace: Transition["namespace"]): boolean {
	return drawsParticle(kind, namespace) || drawsMorph(kind, namespace)
}

async function prepare(request: ShowTransitionRequest): Promise<ShowTransitionPrepared | undefined> {
	const transition = request.transition
	const owner: unknown = Reflect.get(globalThis, "document")

	if (!draws(transition.kind, transition.namespace) || !(owner instanceof Document)) return undefined

	const device = GlDevice.acquire(owner)

	if (device === undefined) return undefined

	const isMorph = transition.namespace === "morph"

	// Compiled now, off the frame that starts the run.
	const shape = isMorph ? undefined : particleShape(transition, 16 / 9)
	const programs = await Promise.all(
		(isMorph ? (["morph"] as const) : (["compose", shape?.program ?? "compose"] as const)).map(name => device.prepareProgram(name))
	)

	if (programs.some(program => program === undefined) || request.signal.aborted) {
		device.release()

		return undefined
	}

	if (!isMorph) return new Prepared(request.outgoing, device, undefined)

	const morph = await prepareMorph(request, device, owner)

	if (morph === undefined) {
		device.release()

		return undefined
	}

	return new Prepared(request.outgoing, device, morph)
}

// A run releases the device it took when it finishes; a prepared transition keeps its own reference.
function owned(run: ShowTransitionRun | undefined, device: GlDevice): ShowTransitionRun | undefined {
	if (run === undefined) {
		device.release()

		return undefined
	}

	return {
		frame: progress => run.frame(progress),
		finish() {
			run.finish()
			device.release()
		}
	}
}

function start(context: ShowTransitionContext): ShowTransitionRun | undefined {
	const transition = context.transition

	if (!draws(transition.kind, transition.namespace)) return undefined

	const prepared = context.prepared instanceof Prepared ? context.prepared : undefined
	// The run's own reference: the player may release the prepared transition while the run plays.
	const device = GlDevice.acquire(context.document)

	if (device === undefined) return undefined

	if (transition.namespace !== "morph") return owned(startParticles(context, device), device)

	const morph = prepared?.morph

	// Prepared on a context since lost, the textures went with it.
	if (prepared === undefined || morph === undefined || prepared.device !== device) {
		device.release()

		return undefined
	}

	return owned(startMorph(context, device, morph), device)
}

// Makes the document's WebGL2 context, and compiles the programs of the kinds the deck uses, as the show starts
// (`kinds`: the transition kinds the deck's slides use), so no slide's preparation pays for it while another animates;
// nothing for a deck without a particle transition or morph. Held until the show releases it.
export function warmWebgl(document: Document, kinds: readonly string[]): { release(): void } | undefined {
	const used = kinds.filter(kind => WEBGL_TRANSITION_KINDS.has(kind))

	if (used.length === 0 || !hasWebgl2()) return undefined

	const device = GlDevice.acquire(document)

	if (device === undefined) return undefined

	const names = new Set<ProgramName>(["compose"])

	for (const kind of used) {
		if (kind === "morph") names.add("morph")
		else {
			const shape = particleShape({ kind, namespace: "p14", options: {}, advance: { onClick: true } }, 16 / 9)

			if (shape !== undefined) names.add(shape.program)
		}
	}

	for (const name of names) void device.prepareProgram(name)

	let released = false

	return {
		release() {
			if (released) return

			released = true
			device.release()
		}
	}
}

export const webglTransitions: ShowTransitionRenderer = { draws, prepare, start, warm: warmWebgl }
