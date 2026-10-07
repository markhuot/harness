import Foundation
import Observation

/// What PushRegistrar needs from a service (HarnessClient), as a seam for tests.
public protocol PushClient: Sendable {
    func registerDevice(_ body: RegisterDeviceBody) async throws -> Device
    func removeDevice(_ id: String) async throws -> OkResponse
}

extension HarnessClient: PushClient {}

/// Registers this device's APNs token with every saved Mac (POST /devices), so each Mac's service
/// can push to it, and unregisters it from a Mac that's forgotten (DELETE /devices/:id).
///
/// `sync` registers with each Mac the current token isn't registered with yet (in this launch):
/// call it when the token arrives or changes, when a Mac is added, paired again or comes back,
/// and at launch (a fresh registrar has registered nothing, so a launch re-registers everywhere).
/// A Mac that can't be reached is tried again on the next `sync`.
@MainActor
@Observable
public final class PushRegistrar {
    public typealias MakeClient = @Sendable (ActiveServer) -> any PushClient

    /// The hex APNs token, once the system has handed one over.
    public private(set) var apnsToken: String?
    /// The last failure per server id (cleared when it registers).
    public private(set) var errors: [String: String] = [:]

    public let deviceId: String
    public let name: String
    public let environment: ApnsEnvironment
    @ObservationIgnored private let makeClient: MakeClient
    /// Per server id: the registration that went through (`signature`).
    @ObservationIgnored private var registered: [String: String] = [:]
    @ObservationIgnored private var inFlight: [String: String] = [:]

    public init(deviceId: String, name: String, environment: ApnsEnvironment, makeClient: @escaping MakeClient = PushRegistrar.liveClient) {
        self.deviceId = deviceId
        self.name = name
        self.environment = environment
        self.makeClient = makeClient
    }

    public static let liveClient: MakeClient = { HarnessClient(baseUrl: $0.baseUrl, token: $0.token) }

    /// The body POST /devices gets for `token`.
    public func body(token: String) -> RegisterDeviceBody {
        RegisterDeviceBody(id: deviceId, platform: .ios, name: name, apnsToken: token, environment: environment, topic: Notifications.apnsTopic)
    }

    /// A new (or the same) token from the system; registers it with `servers`.
    public func setToken(_ token: String, servers: [ActiveServer]) async {
        if token != apnsToken {
            apnsToken = token
            registered = [:]
        }
        await sync(servers)
    }

    /// Registers the token with each of `servers` it isn't registered with yet, all at once.
    /// Nothing happens before the system has handed over a token.
    public func sync(_ servers: [ActiveServer]) async {
        guard let token = apnsToken else { return }
        let todo = servers.filter { s in
            let sig = signature(s, token)
            return registered[s.id] != sig && inFlight[s.id] != sig
        }
        guard !todo.isEmpty else { return }
        let body = body(token: token)
        for s in todo { inFlight[s.id] = signature(s, token) }
        let makeClient = makeClient
        let results = await withTaskGroup(of: (ActiveServer, String?).self) { group in
            for s in todo {
                group.addTask {
                    do {
                        _ = try await makeClient(s).registerDevice(body)
                        return (s, nil)
                    } catch {
                        return (s, error.localizedDescription)
                    }
                }
            }
            var out: [(ActiveServer, String?)] = []
            for await r in group { out.append(r) }
            return out
        }
        for (s, error) in results {
            let sig = signature(s, token)
            if inFlight[s.id] == sig { inFlight[s.id] = nil }
            if let error {
                errors[s.id] = error
            } else if apnsToken == token {
                registered[s.id] = sig
                errors[s.id] = nil
            }
        }
    }

    /// Takes this device off a Mac that's being forgotten. Best effort: a Mac that can't be
    /// reached keeps a registration Apple will report as stale once the app is gone.
    public func unregister(_ server: ActiveServer) async {
        registered[server.id] = nil
        inFlight[server.id] = nil
        errors[server.id] = nil
        _ = try? await makeClient(server).removeDevice(deviceId)
    }

    /// Whether the current token is registered with `serverId`.
    public func isRegistered(_ serverId: String) -> Bool {
        guard let token = apnsToken, let sig = registered[serverId] else { return false }
        return sig.hasSuffix("|\(token)")
    }

    /// A registration is good for one address, bearer token and APNs token: a re-pair (new
    /// address or token) registers again.
    private func signature(_ s: ActiveServer, _ apns: String) -> String { "\(s.baseUrl)|\(s.token)|\(apns)" }
}
