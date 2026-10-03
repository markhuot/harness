import Foundation

/// This app and the service it's connected to come from different releases (CLAUDE.md →
/// Releases): the Mac app's banner for a service running other code, for the phone. Both sides
/// name a release by its app-YYYYMMDD.HHMM tag: the service reports it on /health, and a release
/// build of this app carries the tag's digits as its CFBundleVersion.
public enum ReleaseMismatch: Equatable, Sendable {
    case appOlder(app: String, service: String)
    case appNewer(app: String, service: String)

    public var app: String {
        switch self {
        case let .appOlder(app, _), let .appNewer(app, _): return app
        }
    }

    public var service: String {
        switch self {
        case let .appOlder(_, service), let .appNewer(_, service): return service
        }
    }

    public var title: String {
        switch self {
        case .appOlder: return "This app is older than the harness service."
        case .appNewer: return "The harness service is older than this app."
        }
    }

    public var detail: String {
        let versions = "App \(app), service \(service)."
        switch self {
        case .appOlder: return "\(versions) Update Harness from TestFlight."
        case .appNewer: return "\(versions) Update Harness on the Mac."
        }
    }
}

public enum Releases {
    /// A release build's CFBundleVersion (the tag's 12 digits) as its tag; nil for development
    /// builds, which don't belong to a release.
    public static func tag(buildNumber: String?) -> String? {
        guard let b = buildNumber, b.count == 12, b.allSatisfy(\.isASCIIDigit) else { return nil }
        return "app-\(b.prefix(8)).\(b.suffix(4))"
    }

    /// The tag's digits, which order releases; nil for anything that isn't app-YYYYMMDD.HHMM.
    public static func digits(tag: String?) -> String? {
        guard let t = tag, t.hasPrefix("app-") else { return nil }
        let parts = t.dropFirst(4).split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 8, parts[1].count == 4,
              parts.allSatisfy({ $0.allSatisfy(\.isASCIIDigit) }) else { return nil }
        return String(parts[0] + parts[1])
    }

    /// The mismatch between this app's build and the service's release; nil when they match or
    /// either side can't tell (a development build, or a service from before releases).
    public static func mismatch(appBuild: String?, serviceRelease: String?) -> ReleaseMismatch? {
        guard let app = tag(buildNumber: appBuild), let appDigits = digits(tag: app),
              let service = serviceRelease, let serviceDigits = digits(tag: service),
              appDigits != serviceDigits else { return nil }
        return appDigits < serviceDigits ? .appOlder(app: app, service: service) : .appNewer(app: app, service: service)
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}
