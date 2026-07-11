import { type, type Type } from "arktype"
import { storageRole, onStorageLeadershipChange } from "@/lib/storage/leader"
import { storage } from "@/lib/storage/adapter"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"

// Shared leader-owned-outbox core, reused by the notes AND chats send outboxes (both ride the SAME db-lock
// leadership — no second election). It owns the mechanical, feature-agnostic half of a coordinator: the
// cross-tab channel plumbing (a dedicated BroadcastChannel, envelope-encoded), the leader/follower role
// wiring off the db-lock signal, and the promotion replay hook. Each feature keeps its own thin coordinator
// (message routing + arktype schemas) and its own Sync class — only the shapes flowing over the channel
// differ; the plumbing is identical. This channel NEVER touches the db RPC protocol.

// follower → leader: forward one edit (envelope-encoded feature payload) / request a flush / request state.
// leader → followers: authoritative state (envelope-encoded) + a takeover announcement.
export type OutboxChannelMsg =
	| { kind: "enqueue"; payload: string }
	| { kind: "executeNow" }
	| { kind: "stateRequest" }
	| { kind: "state"; payload: string }
	| { kind: "leaderHello" }

// The domain-agnostic transport a Sync class depends on: E is the follower's forwarded-edit shape, S the
// leader's broadcast-state shape. Both cross the channel as $bigint envelopes. A single-tab install attaches
// NO transport, so every method is a guarded no-op in the Sync class and the leader path stays byte-identical.
export interface OutboxChannelTransport<E, S> {
	// follower → leader
	sendEnqueue: (msg: E) => void
	sendExecuteNow: () => void
	requestState: () => void
	// leader → followers
	broadcastState: (state: S) => void
	broadcastLeaderHello: () => void
}

// Bind a channel to the transport surface — the identical mechanical mapping both features used inline:
// envelope-encode the feature payload and post the shared message kinds.
export function makeOutboxChannelTransport<E, S>(channel: BroadcastChannel): OutboxChannelTransport<E, S> {
	const post = (msg: OutboxChannelMsg): void => {
		channel.postMessage(msg)
	}

	return {
		sendEnqueue: msg => {
			post({ kind: "enqueue", payload: stringifyEnvelope(msg) })
		},
		sendExecuteNow: () => {
			post({ kind: "executeNow" })
		},
		requestState: () => {
			post({ kind: "stateRequest" })
		},
		broadcastState: state => {
			post({ kind: "state", payload: stringifyEnvelope(state) })
		},
		broadcastLeaderHello: () => {
			post({ kind: "leaderHello" })
		}
	}
}

// Decode + validate an envelope-encoded payload; a corrupt message is dropped (never thrown up into the
// channel callback), the same convention as the kv read path.
export function decodeOutboxPayload<T>(payload: string, schema: Type<T>, context: string): T | null {
	let parsed: unknown

	try {
		parsed = parseEnvelope(payload)
	} catch {
		log.warn("outbox-channel", `dropping unparseable ${context}`)

		return null
	}

	const out = schema(parsed)

	if (out instanceof type.errors) {
		log.warn("outbox-channel", `dropping invalid ${context}`, out.summary)

		return null
	}

	return out as T
}

// The role-lifecycle a Sync class exposes to the coordinator — a live role read plus the three transitions
// the leadership signal drives.
export interface OutboxLeadershipTarget {
	readonly outboxRole: "leader" | "follower"
	start: () => void
	startAsFollower: () => void
	promoteToLeader: () => void
}

// Wire a leader-owned outbox to the db-lock leadership: create its dedicated channel, let the caller attach
// its transport + message handler over it, then adopt the initial role from the lock and subscribe to
// promotion. A follower that wins the lock after the leader dies hands itself the loop via promoteToLeader().
// Guard on the target's OWN role so a redundant signal (or the initial leader's own start) never double-
// promotes.
export async function bindOutboxLeadership(
	channelName: string,
	target: OutboxLeadershipTarget,
	bindChannel: (channel: BroadcastChannel) => void
): Promise<void> {
	const channel = new BroadcastChannel(channelName)

	bindChannel(channel)

	const promoteIfNeeded = (): void => {
		if (storageRole() === "leader" && target.outboxRole === "follower") {
			target.promoteToLeader()
		}
	}

	onStorageLeadershipChange(promoteIfNeeded)

	const { role } = await storage()

	if (role === "leader") {
		target.start()
	} else {
		target.startAsFollower()
	}

	// Close the race between `await storage()` resolving as follower and the subscription above: a promotion
	// that landed in that gap fired with no follower role yet set, so re-check once now.
	promoteIfNeeded()
}
