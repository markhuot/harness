import SwiftUI
import UIKit

/// The stage's touch surface: one finger's raw began/moved/ended/cancelled with UITouch
/// timestamps, for TouchGesture, and two fingers' pinch for BrowserPinch. A gesture recognizer
/// rather than a SwiftUI DragGesture because it reports cancellation, and because it keeps the
/// touch once it has it: an enclosing scroll or paging view can't take a drag over the page away.
///
/// With `pinch`, a second finger landing cancels the first finger's page gesture (no click) and
/// starts a pinch; nothing from the pinch reaches the page, and once it ends the finger still down
/// is ignored until every finger lifts. Without it (the annotator) a second finger is ignored, as is
/// a third either way.
struct BrowserTouchSurface: UIViewRepresentable {
    struct Pinch {
        var began: (CGPoint, CGPoint, Double) -> Void
        var moved: (CGPoint, CGPoint) -> Void
        var ended: (Double) -> Void
        var cancelled: () -> Void
    }

    struct Handlers {
        var began: (CGPoint, Double) -> Void
        var moved: (CGPoint, Double) -> Void
        var ended: (CGPoint, Double) -> Void
        var cancelled: () -> Void
        var pinch: Pinch?
    }

    var enabled: Bool
    var handlers: Handlers

    init(
        enabled: Bool, began: @escaping (CGPoint, Double) -> Void, moved: @escaping (CGPoint, Double) -> Void,
        ended: @escaping (CGPoint, Double) -> Void, cancelled: @escaping () -> Void, pinch: Pinch? = nil
    ) {
        self.enabled = enabled
        handlers = Handlers(began: began, moved: moved, ended: ended, cancelled: cancelled, pinch: pinch)
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isMultipleTouchEnabled = true
        view.addGestureRecognizer(context.coordinator.recognizer)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        let r = context.coordinator.recognizer
        r.isEnabled = enabled
        r.handlers = handlers
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator {
        let recognizer = Recognizer()
    }

    final class Recognizer: UIGestureRecognizer {
        var handlers: Handlers?
        /// The one finger driving the page.
        private weak var tracked: UITouch?
        /// The two fingers of a pinch.
        private var pinch: (a: UITouch, b: UITouch)?
        /// A pinch ended with this finger still down: it's ignored until it lifts.
        private var leftover: UITouch?

        override init(target: Any?, action: Selector?) {
            super.init(target: target, action: action)
            cancelsTouchesInView = false
            delaysTouchesEnded = false
        }

        convenience init() { self.init(target: nil, action: nil) }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            for t in touches {
                if leftover != nil || pinch != nil {
                    ignore(t, for: event)
                } else if let first = tracked {
                    guard let p = handlers?.pinch else {
                        ignore(t, for: event)
                        continue
                    }
                    // A second finger: the page gesture is cancelled, the pinch takes over.
                    tracked = nil
                    pinch = (first, t)
                    state = .changed
                    handlers?.cancelled()
                    p.began(first.location(in: view), t.location(in: view), t.timestamp * 1000)
                } else {
                    tracked = t
                    state = .began
                    handlers?.began(t.location(in: view), t.timestamp * 1000)
                }
            }
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
            if let (a, b) = pinch {
                guard touches.contains(a) || touches.contains(b) else { return }
                state = .changed
                handlers?.pinch?.moved(a.location(in: view), b.location(in: view))
                return
            }
            guard let t = tracked, touches.contains(t) else { return }
            state = .changed
            handlers?.moved(t.location(in: view), t.timestamp * 1000)
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
            if let (a, b) = pinch {
                guard let lifted = touches.first(where: { $0 === a || $0 === b }) else { return }
                pinch = nil
                handlers?.pinch?.ended(lifted.timestamp * 1000)
                finishPinch(touches, a, b)
                return
            }
            if let t = leftover, touches.contains(t) {
                leftover = nil
                state = .ended
                return
            }
            guard let t = tracked, touches.contains(t) else { return }
            tracked = nil
            handlers?.ended(t.location(in: view), t.timestamp * 1000)
            state = .ended
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
            if let (a, b) = pinch {
                guard touches.contains(a) || touches.contains(b) else { return }
                pinch = nil
                handlers?.pinch?.cancelled()
                state = .cancelled
                return
            }
            if let t = leftover, touches.contains(t) {
                leftover = nil
                state = .cancelled
                return
            }
            guard let t = tracked, touches.contains(t) else { return }
            tracked = nil
            handlers?.cancelled()
            state = .cancelled
        }

        /// One or both pinch fingers lifted: done once both are up, else wait out the other.
        private func finishPinch(_ touches: Set<UITouch>, _ a: UITouch, _ b: UITouch) {
            if touches.contains(a), touches.contains(b) {
                state = .ended
            } else {
                leftover = touches.contains(a) ? b : a
                state = .changed
            }
        }

        override func reset() {
            super.reset()
            if tracked != nil {
                tracked = nil
                handlers?.cancelled()
            }
            if pinch != nil {
                pinch = nil
                handlers?.pinch?.cancelled()
            }
            leftover = nil
        }

        // Once a finger is on the page, nothing else gets it.
        override func canBePrevented(by preventing: UIGestureRecognizer) -> Bool { false }
        override func canPrevent(_ prevented: UIGestureRecognizer) -> Bool { true }
    }
}

/// The hidden text field that carries the keyboard into the page:
/// text changes, Return, Tab (hardware keyboards) and Backspace on an empty field. `focused`
/// follows the field and moves it.
struct BrowserKeyField: UIViewRepresentable {
    @Binding var focused: Bool
    /// The text changed; return true to clear the field.
    var onText: (String) -> Bool
    /// "Enter", "Tab" or "Backspace".
    var onKey: (String) -> Void

    func makeUIView(context: Context) -> KeyTextField {
        let field = KeyTextField()
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.returnKeyType = .default
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.isAccessibilityElement = false
        return field
    }

    func updateUIView(_ field: KeyTextField, context: Context) {
        context.coordinator.parent = self
        field.onKey = onKey
        if focused != field.isFirstResponder {
            let want = focused
            DispatchQueue.main.async {
                if want, !field.isFirstResponder { field.becomeFirstResponder() } else if !want, field.isFirstResponder { field.resignFirstResponder() }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class KeyTextField: UITextField {
        var onKey: (String) -> Void = { _ in }

        override func deleteBackward() {
            if (text ?? "").isEmpty { onKey("Backspace") }
            super.deleteBackward()
        }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            if presses.contains(where: { $0.key?.keyCode == .keyboardTab }) {
                onKey("Tab")
                return
            }
            super.pressesBegan(presses, with: event)
        }

        override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            // The page gets Tab, so it doesn't move focus out of the field.
            if presses.contains(where: { $0.key?.keyCode == .keyboardTab }) { return }
            super.pressesEnded(presses, with: event)
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: BrowserKeyField

        init(_ parent: BrowserKeyField) { self.parent = parent }

        @objc func changed(_ field: UITextField) {
            if parent.onText(field.text ?? "") { field.text = "" }
        }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            parent.onKey("Enter")
            return false
        }

        func textFieldDidBeginEditing(_ field: UITextField) {
            if !parent.focused { parent.focused = true }
        }

        func textFieldDidEndEditing(_ field: UITextField) {
            if parent.focused { parent.focused = false }
        }
    }
}
