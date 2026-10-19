import SwiftUI
import UIKit

/// Reads where the system's bottom bar draws its buttons, in the window: SwiftUI hands out no frame
/// for a toolbar item, and the docked cards take the bar's edges (DockBar). Put it in the board's
/// background; it measures again when `trigger` changes (the bar's inset moving), the board's size
/// does (a rotation) and a beat after it appears, once the bar has laid out.
struct BarButtonsProbe: UIViewRepresentable {
    let trigger: CGFloat
    let onItems: ([CGRect]) -> Void

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.onItems = onItems
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        view.onItems = onItems
        view.measureSoon()
    }

    final class ProbeView: UIView {
        var onItems: ([CGRect]) -> Void = { _ in }
        private var pending = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            measureSoon()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            measureSoon()
        }

        /// Next run loop and again a beat later: the bar lays out after the board does.
        func measureSoon() {
            guard window != nil, !pending else { return }
            pending = true
            DispatchQueue.main.async { [weak self] in self?.measure() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.measure() }
        }

        private func measure() {
            pending = false
            // A sheet over the board brings glass of its own: the bar hasn't moved, keep the last reading.
            guard let window, window.rootViewController?.presentedViewController == nil else { return }
            var items: [CGRect] = []
            collect(window, in: window, into: &items)
            onItems(items)
        }

        /// The bottom bar's buttons: the glass each one sits on (a custom item, like Projects, is no
        /// `_UIButtonBarButton`), the outermost in the window's lower half.
        private func collect(_ view: UIView, in window: UIWindow, into items: inout [CGRect]) {
            for sub in view.subviews where !sub.isHidden && sub.alpha > 0.01 {
                let name = String(describing: type(of: sub))
                let frame = sub.convert(sub.bounds, to: window)
                if name.contains("GlassInteractionView"), frame.midY > window.bounds.height / 2, frame.width > 20, frame.height > 20 {
                    items.append(frame)
                } else {
                    collect(sub, in: window, into: &items)
                }
            }
        }
    }
}
