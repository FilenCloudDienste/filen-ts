import FileProvider
import Foundation
import NodeAPI

// Identical in the extension. Requested for the root container.
@objc(FilenFileProviderAuthService) protocol FilenFileProviderAuthService {
	func setAuth(_ authFile: Data, reply: @escaping (NSError?) -> Void)
	func clearAuth(reply: @escaping (NSError?) -> Void)
}

private let authServiceName = NSFileProviderServiceName("io.filen.FileProviderAuth")
// Covers the whole XPC round trip, the extension's launch included, so a hung extension cannot hold a call open.
private let authTimeout = DispatchTimeInterval.seconds(30)
private let maxIdentifierBytes = 255
private let maxDisplayNameBytes = 255
private let maxAuthBytes = 1 << 20

// The system keys domains by identifier; the display name is only read by addDomain.
private func domain(_ identifier: String, displayName: String? = nil) -> NSFileProviderDomain {
	NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(rawValue: identifier), displayName: displayName ?? identifier)
}

private func completion(_ pending: Pending) -> @Sendable (Error?) -> Void {
	{ error in
		pending.settle(error.map(Outcome.init) ?? .done)
	}
}

private func invalid(_ env: napi_env, _ message: String) -> napi_value? {
	rejected(env, Outcome(.invalidArgument, message))
}

// `identifier` of the call's `{ identifier }` argument.
private func identifierArgument(_ env: napi_env, _ info: napi_callback_info?) -> String? {
	objectArgument(env, info).flatMap { stringArgument(env, property(env, $0, "identifier"), maxBytes: maxIdentifierBytes) }
}

// One XPC call to the extension's auth service over a connection used once and invalidated on settling.
private func callAuthService(
	_ identifier: String,
	_ pending: Pending,
	_ call: @escaping @Sendable (FilenFileProviderAuthService, @escaping @Sendable (NSError?) -> Void) -> Void
) {
	DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + authTimeout) {
		pending.settle(Outcome(.timedOut, "The File Provider extension did not answer"))
	}

	guard let manager = NSFileProviderManager(for: domain(identifier)) else {
		pending.settle(Outcome(.domainUnavailable, "No File Provider manager for the domain"))

		return
	}

	manager.getService(named: authServiceName, for: .rootContainer) { service, error in
		guard let service else {
			pending.settle(error.map(Outcome.init) ?? Outcome(.serviceUnavailable, "The File Provider extension offers no auth service"))

			return
		}

		service.getFileProviderConnection { connection, error in
			guard let connection else {
				pending.settle(error.map(Outcome.init) ?? Outcome(.serviceUnavailable, "No connection to the File Provider extension"))

				return
			}

			guard pending.attach(connection) else {
				connection.invalidate()

				return
			}

			connection.remoteObjectInterface = NSXPCInterface(with: FilenFileProviderAuthService.self)
			connection.resume()

			let proxy = connection.remoteObjectProxyWithErrorHandler { error in
				pending.settle(Outcome(error))
			}

			guard let auth = proxy as? FilenFileProviderAuthService else {
				pending.settle(Outcome(.serviceUnavailable, "The auth service has an unexpected interface"))

				return
			}

			call(auth) { error in
				pending.settle(error.map(Outcome.init) ?? .done)
			}
		}
	}
}

// addDomain({ identifier, displayName }): adds the domain, or updates the display name of an existing one.
private func addDomain(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard let args = objectArgument(env, info) else {
		return invalid(env, "expected an options object")
	}

	guard let identifier = stringArgument(env, property(env, args, "identifier"), maxBytes: maxIdentifierBytes) else {
		return invalid(env, "identifier must be a string of 1 to 255 UTF-8 bytes")
	}

	guard let displayName = stringArgument(env, property(env, args, "displayName"), maxBytes: maxDisplayNameBytes) else {
		return invalid(env, "displayName must be a string of 1 to 255 UTF-8 bytes")
	}

	return start(env) { pending in
		NSFileProviderManager.add(domain(identifier, displayName: displayName), completionHandler: completion(pending))
	}
}

// removeDomain({ identifier }): removes the domain and its replicated files (.removeAll). Nothing is preserved because a
// removal is a logout or a disable, after which no copy of the account's files may stay on disk.
private func removeDomain(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard let identifier = identifierArgument(env, info) else {
		return invalid(env, "identifier must be a string of 1 to 255 UTF-8 bytes")
	}

	return start(env) { pending in
		NSFileProviderManager.remove(domain(identifier), mode: .removeAll) { _, error in
			completion(pending)(error)
		}
	}
}

// listDomains(): the app's domains.
private func listDomains(env: napi_env?, info _: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	return start(env) { pending in
		NSFileProviderManager.getDomainsWithCompletionHandler { domains, error in
			if let error {
				pending.settle(Outcome(error))

				return
			}

			pending.settle(
				.domains(
					domains.map {
						DomainInfo(identifier: $0.identifier.rawValue, displayName: $0.displayName, userEnabled: $0.userEnabled)
					}
				)
			)
		}
	}
}

// signalWorkingSet({ identifier }): asks the system to re-enumerate the domain's working set.
private func signalWorkingSet(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard let identifier = identifierArgument(env, info) else {
		return invalid(env, "identifier must be a string of 1 to 255 UTF-8 bytes")
	}

	return start(env) { pending in
		guard let manager = NSFileProviderManager(for: domain(identifier)) else {
			pending.settle(Outcome(.domainUnavailable, "No File Provider manager for the domain"))

			return
		}

		manager.signalEnumerator(for: .workingSet, completionHandler: completion(pending))
	}
}

// pushAuth({ identifier, json }): hands the extension its session. The JSON never appears in an error.
private func pushAuth(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard let args = objectArgument(env, info) else {
		return invalid(env, "expected an options object")
	}

	guard let identifier = stringArgument(env, property(env, args, "identifier"), maxBytes: maxIdentifierBytes) else {
		return invalid(env, "identifier must be a string of 1 to 255 UTF-8 bytes")
	}

	guard let authFile = utf8Argument(env, property(env, args, "json"), maxBytes: maxAuthBytes) else {
		return invalid(env, "json must be a non-empty string of at most 1 MiB")
	}

	return start(env) { pending in
		callAuthService(identifier, pending) { auth, reply in
			auth.setAuth(authFile, reply: reply)
		}
	}
}

// clearAuth({ identifier }): has the extension drop its session and cache.
private func clearAuth(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard let identifier = identifierArgument(env, info) else {
		return invalid(env, "identifier must be a string of 1 to 255 UTF-8 bytes")
	}

	return start(env) { pending in
		callAuthService(identifier, pending) { auth, reply in
			auth.clearAuth(reply: reply)
		}
	}
}

@_cdecl("napi_register_module_v1")
public func registerModule(env: napi_env?, exports: napi_value?) -> napi_value? {
	guard let env else {
		return nil
	}

	let methods: [(String, napi_callback)] = [
		("addDomain", addDomain),
		("removeDomain", removeDomain),
		("listDomains", listDomains),
		("signalWorkingSet", signalWorkingSet),
		("pushAuth", pushAuth),
		("clearAuth", clearAuth)
	]

	for (name, method) in methods {
		var function: napi_value?

		guard
			napi_create_function(env, name, name.utf8.count, method, nil, &function) == napi_ok,
			napi_set_named_property(env, exports, name, function) == napi_ok
		else {
			return nil
		}
	}

	return exports
}
