import Foundation
import NodeAPI

// Promises whose work runs off the JS thread and that settle back on it through a threadsafe function.

// What a promise settles with: resolves or rejects on the JS thread.
protocol Settlement: Sendable {
	// Rejects a promise whose threadsafe function could not be created.
	static func internalFailure(_ message: String) -> Self

	func settle(_ env: napi_env, _ deferred: napi_deferred)
}

// One settlement on its way to the JS thread.
private final class Delivery {
	let deferred: napi_deferred
	let settlement: any Settlement

	init(deferred: napi_deferred, settlement: any Settlement) {
		self.deferred = deferred
		self.settlement = settlement
	}
}

// Runs on the JS thread; env is nil while the function is torn down, when only the delivery is freed.
private func deliver(env: napi_env?, _: napi_value?, _: UnsafeMutableRawPointer?, data: UnsafeMutableRawPointer?) {
	guard let data else {
		return
	}

	let delivery = Unmanaged<Delivery>.fromOpaque(data).takeRetainedValue()

	if let env {
		delivery.settlement.settle(env, delivery.deferred)
	}
}

// A promise settled from any thread, exactly once. Its threadsafe function is released on settling; a cleanup attached
// to it runs then.
final class PendingPromise<S: Settlement>: @unchecked Sendable {
	private let deferred: napi_deferred
	private let tsfn: napi_threadsafe_function
	private let lock = NSLock()
	private var settled = false
	private var cleanup: (() -> Void)?

	fileprivate init(deferred: napi_deferred, tsfn: napi_threadsafe_function) {
		self.deferred = deferred
		self.tsfn = tsfn
	}

	// false when already settled; the caller then cleans up itself.
	func attach(cleanup: @escaping () -> Void) -> Bool {
		lock.lock()
		defer { lock.unlock() }

		guard !settled else {
			return false
		}

		self.cleanup = cleanup

		return true
	}

	func settle(_ settlement: S) {
		lock.lock()

		let first = !settled
		let cleanup = self.cleanup

		settled = true
		self.cleanup = nil
		lock.unlock()

		guard first else {
			return
		}

		cleanup?()

		let delivery = Unmanaged.passRetained(Delivery(deferred: deferred, settlement: settlement))

		// Fails only while the environment shuts down, when nothing is left to settle.
		if napi_call_threadsafe_function(tsfn, delivery.toOpaque(), napi_tsfn_nonblocking) != napi_ok {
			delivery.release()
		}

		napi_release_threadsafe_function(tsfn, napi_tsfn_release)
	}
}

// A promise settled before any work starts.
func rejected(_ env: napi_env, _ settlement: some Settlement) -> napi_value? {
	var deferred: napi_deferred?
	var promise: napi_value?

	guard napi_create_promise(env, &deferred, &promise) == napi_ok, let deferred else {
		return nil
	}

	settlement.settle(env, deferred)

	return promise
}

// A promise whose work runs on `queue` and settles through `PendingPromise`; `name` labels its threadsafe function.
func start<S: Settlement>(
	_ env: napi_env,
	name: String,
	queue: DispatchQueue,
	_ work: @escaping @Sendable (PendingPromise<S>) -> Void
) -> napi_value? {
	var deferred: napi_deferred?
	var promise: napi_value?
	var tsfn: napi_threadsafe_function?

	guard napi_create_promise(env, &deferred, &promise) == napi_ok, let deferred else {
		return nil
	}

	guard
		napi_create_threadsafe_function(env, nil, nil, string(env, name), 0, 1, nil, nil, nil, deliver, &tsfn) == napi_ok,
		let tsfn
	else {
		S.internalFailure("Could not create a threadsafe function").settle(env, deferred)

		return promise
	}

	let pending = PendingPromise<S>(deferred: deferred, tsfn: tsfn)

	queue.async {
		work(pending)
	}

	return promise
}
