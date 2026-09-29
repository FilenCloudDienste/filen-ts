import { type, type Type } from "arktype"
import { storageRole, onStorageLeadershipChange } from "@/lib/storage/leader"
import { storage } from "@/lib/storage/adapter"
import { log } from "@/lib/log"

// Shared leader-owned-outbox core, reused by the notes AND chats send outboxes (both ride the SAME db-lock
// leadership — no second election). It owns the mechanical, feature-agnostic half of a coordinator: the
// cross-tab channel plumbing (a dedicated BroadcastChannel), the leader/follower role wiring off the db-lock
// signal, the promotion replay hook, and the role-routed dispatch of the shared message kinds. Each feature
// keeps its own thin coordinator (arktype schemas + any feature-only kinds) and its own Sync class — only the
// shapes flowing over the channel differ; the plumbing is identical. This channel NEVER touches the db RPC
// protocol.

// follower → leader: forward one edit (the feature payload) / drop an item's queued edits / request a flush /
// request state. leader → followers: authoritative state + a takeover announcement + what is being pushed
// for an item, and again once the cloud holds it (`landed`, also when nothing had to be sent): the hash, and
// the tab and entry it came from (`origin`, `stamp`), so a follower knows the item's socket echo, and its own
// push, for what they are. Any tab → any tab: a question about an item's newer version was answered (and
// how), so the other tabs stop asking it.

// How a question about an item's newer version was answered: their version, mine kept over it, or mine
// saved beside it as a copy (theirs stays).
export type AnswerChoice = "theirs" | "mine" | "copy"

// What a "pushed" post says beyond the item and hash.
export interface PushDetail {
	origin?: string
	stamp?: number
	landed?: true
	// The push buried a newer version: the tab it came from says so.
	overwrote?: true
}

export type OutboxChannelMsg =
	| { kind: "enqueue"; payload: unknown }
	| { kind: "drop"; id: string }
	| { kind: "executeNow" }
	| { kind: "stateRequest" }
	| { kind: "state"; payload: unknown }
	| { kind: "leaderHello" }
	| ({ kind: "pushed"; id: string; hash: string } & PushDetail)
	| { kind: "answered"; id: string; choice?: AnswerChoice }

// The domain-agnostic transport a Sync class depends on: E is the follower's forwarded-edit shape, S the
// leader's broadcast-state shape. Both cross the channel as structured clones, which carry bigint as is. A
// single-tab install attaches NO transport, so every method is a guarded no-op in the Sync class and the
// leader path stays byte-identical.
export interface OutboxChannelTransport<E, S> {
	// follower → leader
	sendEnqueue: (msg: E) => void
	// Optional: only an outbox whose tabs can discard queued edits (notes) sends it.
	sendDrop?: (id: string) => void
	sendExecuteNow: () => void
	requestState: () => void
	// leader → followers
	broadcastState: (state: S) => void
	broadcastLeaderHello: () => void
	broadcastPushed: (id: string, hash: string, detail?: PushDetail) => void
	// any tab → any tab
	broadcastAnswered: (id: string, choice: AnswerChoice) => void
	// Terminal teardown (logout/shutdown): detach the handler and close the channel so no late cross-tab
	// message can reach an outbox that is tearing down — the invariant that gates the plaintext-queue wipe.
	close: () => void
}

// Bind a channel to the transport surface — the identical mechanical mapping both features used inline:
// post the shared message kinds, the feature payload as is.
export function makeOutboxChannelTransport<E, S>(channel: BroadcastChannel): OutboxChannelTransport<E, S> {
	const post = (msg: OutboxChannelMsg): void => {
		channel.postMessage(msg)
	}

	return {
		sendEnqueue: msg => {
			post({ kind: "enqueue", payload: msg })
		},
		sendDrop: id => {
			post({ kind: "drop", id })
		},
		sendExecuteNow: () => {
			post({ kind: "executeNow" })
		},
		requestState: () => {
			post({ kind: "stateRequest" })
		},
		broadcastState: state => {
			post({ kind: "state", payload: state })
		},
		broadcastLeaderHello: () => {
			post({ kind: "leaderHello" })
		},
		broadcastPushed: (id, hash, detail) => {
			post({ kind: "pushed", id, hash, ...detail })
		},
		broadcastAnswered: (id, choice) => {
			post({ kind: "answered", id, choice })
		},
		close: () => {
			closeOutbox(channel)
		}
	}
}

// Tear a channel down: drop its handler first (so an in-flight dispatch cannot re-enter after close) then
// close it. Called on the terminal outbox shutdown (logout) so no forwarded send can land on a wiping tab.
export function closeOutbox(channel: BroadcastChannel): void {
	channel.onmessage = null
	channel.close()
}

// Validate a payload at the trust boundary; an invalid message is dropped (never thrown up into the
// channel callback), the same convention as the kv read path.
export function decodeOutboxPayload<T>(payload: unknown, schema: Type<T>, context: string): T | null {
	const out = schema(payload)

	if (out instanceof type.errors) {
		log.warn("outbox-channel", `dropping invalid ${context}`, out.summary)

		return null
	}

	return out as T
}

// The outbox lifecycle as an explicit state machine: a tab starts "unresolved" (leadership not yet decided —
// leader-branch ingestion MUST no-op so a forward arriving before the role resolves cannot paint a phantom),
// resolves to "leader" or "follower", and a terminal cancel flips it to "shutdown" (logout — no further
// ingest, no disk write). A Sync that only ever reports "leader"/"follower" is still a valid target.
export type OutboxRole = "unresolved" | "leader" | "follower" | "shutdown"

// The role-lifecycle a Sync class exposes to the coordinator — a live role read plus the three transitions
// the leadership signal drives.
export interface OutboxLeadershipTarget {
	readonly outboxRole: OutboxRole
	start: () => void
	startAsFollower: () => void
	promoteToLeader: () => void
}

// What routeOutboxMessage drives: the role read plus the Sync methods each shared message kind lands on.
export interface OutboxRouteTarget<E, S> {
	readonly outboxRole: OutboxRole
	ingestRemoteEnqueue: (msg: E) => void
	executeNow: () => void
	broadcastState: () => void
	applyLeaderState: (state: S) => void
	resendUnacked: () => void
}

// A feature's payload schemas and the labels an invalid payload is logged under. Hold it in a module const
// so dispatch allocates nothing per message.
export interface OutboxRoute<E, S> {
	enqueueSchema: Type<E>
	stateSchema: Type<S>
	enqueueLabel: string
	stateLabel: string
}

// Dispatch the shared message kinds by the outbox's CURRENT role (role flips live on promotion): the leader
// half handles follower forwards, the follower half handles leader broadcasts. A message meant for the other
// role, or a feature-only kind, is ignored here — a tab never acts on its own category.
export function routeOutboxMessage<E, S>(msg: OutboxChannelMsg, target: OutboxRouteTarget<E, S>, route: OutboxRoute<E, S>): void {
	if (target.outboxRole === "leader") {
		switch (msg.kind) {
			case "enqueue": {
				const decoded = decodeOutboxPayload(msg.payload, route.enqueueSchema, route.enqueueLabel)

				if (decoded !== null) {
					target.ingestRemoteEnqueue(decoded)
				}

				return
			}
			case "executeNow": {
				target.executeNow()

				return
			}
			case "stateRequest": {
				target.broadcastState()

				return
			}
			default:
				return
		}
	}

	switch (msg.kind) {
		case "state": {
			const decoded = decodeOutboxPayload(msg.payload, route.stateSchema, route.stateLabel)

			if (decoded !== null) {
				target.applyLeaderState(decoded)
			}

			return
		}
		case "leaderHello": {
			target.resendUnacked()

			return
		}
		default:
			return
	}
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
