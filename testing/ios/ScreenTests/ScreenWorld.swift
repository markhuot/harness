import HarnessKit
import SwiftUI
@testable import Harness

/// Timers that never fire: a refresh fallback or poll that came due mid-render would make a screen
/// depend on how long the run took.
@MainActor
final class NeverTimers: Timers {
    private var next = 0
    func set(_ ms: Double, _ fire: @escaping @MainActor () -> Void) -> TimerHandle {
        next += 1
        return TimerHandle(id: next)
    }
    func clear(_ handle: TimerHandle) {}
}

/// The app's stores over the world: the real HarnessClient and BoardStore, the real AppModel, with
/// the transport and the socket replaced. A screen renders through the production code path.
@MainActor
final class ScreenWorld {
    let json: WorldJSON
    let transport: WorldTransport
    let socket = WorldSocket()
    let store: BoardStore
    let app: AppModel
    let actions = Actions()

    static let address = ServerAddress(baseUrl: "http://world.test", token: "world")

    init(_ json: WorldJSON) async {
        self.json = json
        transport = WorldTransport(json)
        let client = HarnessClient(baseUrl: Self.address.baseUrl, token: Self.address.token, transport: transport)
        let socket = socket
        let store = BoardStore(client: client, baseUrl: Self.address.baseUrl, makeSocket: { socket }, timers: NeverTimers())
        self.store = store
        app = AppModel(storage: MemoryStorage(), probe: { _ in .ok(version: "") }, makeStore: { _, _ in store })
        app.load()
        await app.pair(Self.address, skipProbe: true)
        await loaded()
    }

    /// Wait until the store has its snapshot and nothing is left in flight.
    func loaded() async {
        var spins = 0
        while (!store.state.ready || transport.inflight > 0) && spins < 5_000 {
            await FrameClock.tick()
            spins += 1
        }
    }

    /// The environment every screen gets in the app (HarnessApp, SceneChrome), with the world's clock.
    func environment<V: View>(_ view: V, router: Router, scheme: ColorScheme) -> some View {
        view
            .environment(app)
            .environment(store)
            .environment(router)
            .environment(actions)
            .environment(\.palette, Palette(app.resolvedTheme(systemDark: scheme == .dark)))
            .environment(\.snapshotNow, json.now)
            .environment(\.locale, Locale(identifier: "en_US"))
            .environment(\.timeZone, json.timeZone)
            .environment(\.dynamicTypeSize, .large)
            .preferredColorScheme(scheme)
    }
}
