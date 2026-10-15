#if SIM_CHECK
import Foundation
import HarnessKit
import UIKit

/// The debug state probe: writes `DebugState` as JSON to `<container>/tmp/harness-debug-state.json`
/// about every 50 ms, for ios/Tools/sim-check.ts to read (`simctl get_app_container … data`). A file
/// rather than a URL route and a daemon post: it needs no round trip to land (a read is a file
/// read), nothing from the daemon, and it works before the app is paired. Compiled only into a
/// SIM_CHECK build (build.ts's simulator build sets it; a Debug device build does not), so a device or release build has
/// none of it. The shape and the settle rule are in HarnessKit's DebugState.swift.
@MainActor
final class DebugProbe {
    static let shared = DebugProbe()

    private weak var router: Router?
    /// How many times a dock container has appeared (`DockedCardsContainer`), for `DebugState.dockMounts`.
    private(set) var dockMounts = 0

    func dockMounted() { dockMounts += 1 }
    private var hosts: [WeakHost] = []
    private var settle = DebugSettle()
    private var loop: Task<Void, Never>?
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent(DebugState.fileName)

    /// When each running animation was first seen, so a perpetual one can be told from a transition.
    private var ambient: [String: TimeInterval] = [:]
    private static let ambientAfter: TimeInterval = 2

    private struct WeakHost { weak var host: EditorWebHost? }

    /// Starts writing for the main window's router (a ticket window's router is ignored).
    func attach(_ router: Router) {
        guard router.scope == .main else { return }
        self.router = router
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.write()
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }

    func register(_ host: EditorWebHost) {
        hosts.removeAll { $0.host == nil }
        hosts.append(WeakHost(host: host))
    }

    /// What is moving on screen, in any of the app's windows (the keyboard's and a sheet's included):
    /// a Core Animation animation in flight ("animating:<layer>:<key>", the first few) and a scroll
    /// view being dragged or coasting ("scrolling"). A spinner or a pulse that repeats forever is
    /// part of a screen at rest, so it doesn't count. This is what lets sim-check wait for a sheet
    /// to slide in or a fling to stop instead of sleeping.
    private func motion() -> [String] {
        let now = ProcessInfo.processInfo.systemUptime
        var seen: [String: TimeInterval] = [:]
        var animating: [String] = []
        var scrolling = false
        func walk(_ layer: CALayer) {
            for key in layer.animationKeys() ?? [] {
                guard let a = layer.animation(forKey: key), animating.count < 4,
                      a.repeatCount < 1000, a.repeatDuration < 1000,
                      // The system activity indicator's spinner, which runs for as long as it is shown.
                      !(layer is CAReplicatorLayer) else { continue }
                // One that has run for seconds is ambient (the glass lenses' shimmer), not a transition.
                let id = "\(ObjectIdentifier(layer).hashValue):\(key)"
                let since = ambient[id] ?? now
                seen[id] = since
                if now - since < Self.ambientAfter { animating.append("animating:\(type(of: layer)):\(key)") }
            }
            for sub in layer.sublayers ?? [] { walk(sub) }
        }
        func walk(_ view: UIView) {
            if let scroll = view as? UIScrollView, scroll.isDragging || scroll.isDecelerating { scrolling = true }
            for sub in view.subviews { walk(sub) }
        }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows {
                walk(window.layer)
                walk(window)
            }
        }
        ambient = seen
        return animating + (scrolling ? ["scrolling"] : [])
    }

    /// The text input that is the first responder, by accessibility label (its class when it has none).
    private func focusedInput() -> String? {
        func find(_ view: UIView) -> String? {
            if view.isFirstResponder, view is UITextInput { return view.accessibilityLabel ?? String(describing: type(of: view)) }
            for sub in view.subviews { if let hit = find(sub) { return hit } }
            return nil
        }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows { if let hit = find(window) { return hit } }
        }
        return nil
    }

    private func write() async {
        guard let router else { return }
        // The editor on screen: a file's host has a window, the hidden diff host and parked ones don't.
        let onScreen = hosts.compactMap(\.host).filter { $0.webView.window != nil }
        var state = DebugState(router: DebugState.router(router))
        state.dockMounts = dockMounts
        if onScreen.contains(where: { !$0.ready }) { state.busy.append("editor") }
        state.busy += motion()
        state.focus = focusedInput()
        for host in onScreen where host.ready {
            if let editor = await host.probe() { state.editor = editor; break }
        }
        let stamped = settle.stamp(state, now: ProcessInfo.processInfo.systemUptime)
        if let data = try? stamped.json() { try? data.write(to: url, options: .atomic) }
    }
}
#endif
