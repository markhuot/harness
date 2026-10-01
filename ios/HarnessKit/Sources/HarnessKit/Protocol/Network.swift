import Foundation

public struct ListenSetting: Codable, Sendable, Equatable {
    public var mode: ListenMode
    /// Hostname or IP for mode "custom"
    public var host: String?

    public init(mode: ListenMode, host: String? = nil) {
        self.mode = mode
        self.host = host
    }
}

public struct BoundAddress: Codable, Sendable, Equatable {
    /// The address a listener is bound to, e.g. "127.0.0.1", "100.107.188.66", "0.0.0.0"
    public var address: String
    /// http://<address>:<port> (IPv6 in brackets)
    public var url: String

    public init(address: String, url: String) {
        self.address = address
        self.url = url
    }
}

/// GET /network
public struct NetworkStatus: Codable, Sendable, Equatable {
    /// Tailscale on this machine (`NetworkStatus.tailscale`).
    public struct Tailscale: Codable, Sendable, Equatable {
        public var ip: String
        @Nullable public var dnsName: String?

        public init(ip: String, dnsName: String? = nil) {
            self.ip = ip
            self.dnsName = dnsName
        }
    }

    /// The configured mode (settings.listen.mode, or HARNESS_HOST's)
    public var mode: ListenMode
    /// The configured custom host (mode "custom"), else null
    @Nullable public var host: String?
    public var port: Int
    /// Listeners that are up right now. Always includes loopback (127.0.0.1 or 0.0.0.0).
    public var bound: [BoundAddress]
    /// The mode the bound listeners serve; differs from `mode` while falling back to localhost
    public var active: ListenMode
    /// Tailscale on this machine, when it is running
    @Nullable public var tailscale: Tailscale?
    /// Why the configured mode isn't bound (boot fallback, failed rebind), else null
    @Nullable public var error: String?
    /// HARNESS_HOST when it overrides the setting (the setting can't be changed then)
    @Nullable public var override: String?

    public init(
        mode: ListenMode, host: String? = nil, port: Int, bound: [BoundAddress], active: ListenMode,
        tailscale: Tailscale? = nil, error: String? = nil, override: String? = nil
    ) {
        self.mode = mode
        self.host = host
        self.port = port
        self.bound = bound
        self.active = active
        self.tailscale = tailscale
        self.error = error
        self.override = override
    }
}

/// GET /pairing: what a phone needs to connect. `pairUrl` is what the QR code encodes.
public struct PairingInfo: Codable, Sendable, Equatable {
    /// Base URL on the best reachable non-loopback address, e.g. http://100.107.188.66:7717
    public var url: String
    public var token: String
    /// harness://pair?url=<encodeURIComponent(url)>&token=<encodeURIComponent(token)>
    public var pairUrl: String

    public init(url: String, token: String, pairUrl: String) {
        self.url = url
        self.token = token
        self.pairUrl = pairUrl
    }
}

/// Whether the service runs the code on disk. `stale`: the checkout changed since it started; it
/// restarts onto the new code by itself once no runs are active. `build` is null when the service
/// doesn't track its source (tests, embedded services).
public struct ServiceStatus: Codable, Sendable, Equatable {
    @Nullable public var build: String?
    public var stale: Bool

    public init(build: String? = nil, stale: Bool) {
        self.build = build
        self.stale = stale
    }
}

/// GET /health (unauthenticated). Services from before build tracking omit `build` and `stale`.
public struct Health: Codable, Sendable, Equatable {
    /// Always true
    public var ok: Bool
    public var version: String
    public var pid: Int
    public var build: Patch<String>
    public var stale: Bool?

    public init(ok: Bool = true, version: String, pid: Int, build: Patch<String> = .absent, stale: Bool? = nil) {
        self.ok = ok
        self.version = version
        self.pid = pid
        self.build = build
        self.stale = stale
    }
}
