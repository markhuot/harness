import SwiftUI
import UIKit

/// What the prompt screen does to its editor from outside: where the cursor is (UTF-16, as
/// UITextView reports it; iOS only reports changes, so text the app puts in starts it at the end),
/// focusing it with the cursor at an offset, and blurring it. Not observed.
@MainActor
final class PromptEditorHandle {
    var selection = NSRange(location: 0, length: 0)
    fileprivate weak var view: UITextView?

    /// The cursor at the end of `text` (what replacing the field's text does natively).
    func resetSelection(to text: String?) {
        let n = text?.utf16.count ?? 0
        selection = NSRange(location: n, length: 0)
    }

    /// Focus with the cursor at `caret`, on the next turn of the run loop: the new text lands
    /// natively first (RN's requestAnimationFrame).
    func focus(caret: Int) {
        selection = NSRange(location: caret, length: 0)
        DispatchQueue.main.async { [weak self] in
            guard let self, let view = self.view else { return }
            let n = (view.text ?? "").utf16.count
            view.becomeFirstResponder()
            view.selectedRange = NSRange(location: min(caret, n), length: 0)
            PromptTextEditor.followCaret(view)
        }
    }

    func blur() { view?.resignFirstResponder() }
}

/// The prompt editor: a growing monospaced UITextView with no autocorrection or smart
/// punctuation, inside the screen's ScrollView. It reports the selection to `handle`, and as the
/// text or cursor moves it scrolls the enclosing scroll view so the cursor stays above the keyboard.
struct PromptTextEditor: UIViewRepresentable {
    @Binding var text: String
    let handle: PromptEditorHandle
    let textColor: UIColor
    let accessibilityLabel: String

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isScrollEnabled = false
        v.backgroundColor = .clear
        v.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        v.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        v.autocapitalizationType = .none
        v.autocorrectionType = .no
        v.spellCheckingType = .no
        v.smartQuotesType = .no
        v.smartDashesType = .no
        v.smartInsertDeleteType = .no
        v.inlinePredictionType = .no
        v.keyboardDismissMode = .interactive
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.delegate = context.coordinator
        v.text = text
        handle.view = v
        return v
    }

    func updateUIView(_ v: UITextView, context: Context) {
        context.coordinator.parent = self
        handle.view = v
        v.textColor = textColor
        v.accessibilityLabel = accessibilityLabel
        if v.text != text {
            context.coordinator.applying = true
            v.text = text
            context.coordinator.applying = false
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let fit = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(160, fit.height))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: PromptTextEditor
        /// Set while the app replaces the text, so its selection change isn't taken as the user's.
        var applying = false

        init(_ parent: PromptTextEditor) { self.parent = parent }

        func textViewDidChange(_ v: UITextView) {
            parent.text = v.text
            PromptTextEditor.followCaret(v)
        }

        func textViewDidChangeSelection(_ v: UITextView) {
            guard !applying else { return }
            parent.handle.selection = v.selectedRange
            if v.isFirstResponder { PromptTextEditor.followCaret(v) }
        }
    }

    /// Scrolls the nearest enclosing scroll view so the cursor (plus a line of room) is inside its
    /// visible area, which already excludes the keyboard (its adjusted bottom inset). Deferred a
    /// turn so the field has grown to fit the new text first.
    static func followCaret(_ v: UITextView) {
        DispatchQueue.main.async {
            guard let range = v.selectedTextRange, let scroll = enclosingScrollView(v) else { return }
            let caret = v.convert(v.caretRect(for: range.end), to: scroll)
            let inset = scroll.adjustedContentInset
            let top = scroll.contentOffset.y + inset.top
            let bottom = scroll.contentOffset.y + scroll.bounds.height - inset.bottom
            let room: CGFloat = 16
            var y = scroll.contentOffset.y
            if caret.maxY + room > bottom {
                y += caret.maxY + room - bottom
            } else if caret.minY - room < top {
                y -= top - (caret.minY - room)
            } else {
                return
            }
            let maxY = max(-inset.top, scroll.contentSize.height + inset.bottom - scroll.bounds.height)
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(max(-inset.top, y), maxY)), animated: false)
        }
    }

    private static func enclosingScrollView(_ v: UIView) -> UIScrollView? {
        var s = v.superview
        while let view = s {
            if let scroll = view as? UIScrollView { return scroll }
            s = view.superview
        }
        return nil
    }
}
