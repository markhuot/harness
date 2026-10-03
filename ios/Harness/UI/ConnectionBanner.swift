import HarnessKit
import SwiftUI

/// Connection status, shown only when something is wrong: a
/// rejected token (red, opens Connect to pair again), or disconnected (amber "Reconnecting to …",
/// with the last load error; a tap refreshes). Nothing while connected. Put it at the top of a
/// tab's root screen: `.safeAreaInset(edge: .top) { ConnectionBanner() }`.
struct ConnectionBanner: View {
    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        if store.authError != nil {
            Button { router.present(.connect) } label: {
                HStack(spacing: 8) {
                    Icon("key", size: 14, weight: .semibold)
                    Text("Token changed on the Mac. Tap to pair again.").font(.scaled(size: 13.5)).frame(maxWidth: .infinity, alignment: .leading)
                    Icon("chevronRight", size: 13)
                }
                .foregroundStyle(c.red)
                .padding(10)
                .background(c.redSoft, in: .rect(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.top, 6)
        } else if !store.state.connected {
            Button { Task { await store.refresh() } } label: {
                HStack(spacing: 8) {
                    if store.loadError != nil {
                        Icon("wifiOff", size: 14, weight: .semibold).foregroundStyle(c.amber)
                    } else {
                        Spinner(color: c.amber)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Reconnecting to \(MobilePair.displayHost(store.baseUrl))…")
                            .font(.scaled(size: 13.5, weight: .semibold)).foregroundStyle(c.amber)
                        if let e = store.loadError {
                            Text(e).font(.scaled(size: 12.5)).foregroundStyle(c.text2).lineLimit(3)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 12)
                .background(c.amberSoft, in: .rect(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.top, 6)
        } else if let mismatch = store.releaseMismatch(appBuild: Self.appBuild) {
            HStack(alignment: .top, spacing: 8) {
                Icon("alert", size: 14, weight: .semibold).foregroundStyle(c.amber).padding(.top, 1)
                VStack(alignment: .leading, spacing: 1) {
                    Text(mismatch.title).font(.scaled(size: 13.5, weight: .semibold)).foregroundStyle(c.amber)
                    Text(mismatch.detail).font(.scaled(size: 12.5)).foregroundStyle(c.text2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button { store.dismissReleaseMismatch(mismatch) } label: {
                    Icon("x", size: 13, weight: .semibold).foregroundStyle(c.text2).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
                .padding(.vertical, -6)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .background(c.amberSoft, in: .rect(cornerRadius: 10))
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("release-mismatch")
        }
    }

    /// This build's CFBundleVersion: a release's tag digits, or "1" for a development build.
    static let appBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
}
