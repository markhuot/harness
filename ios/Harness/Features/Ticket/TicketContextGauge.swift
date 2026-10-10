import HarnessKit
import SwiftUI

/// The ticket header's context fuel gauge (DESIGN.md "Context gauge"): a small dial with one needle
/// for the conversation's size and a two-tone fill (slate read from the prompt cache, amber sent
/// fresh), its total beside it, and an amber capsule on its corner counting cache misses. Tapping it
/// opens the session menu: Compact, New session, Limit…, and what the gauge and the misses mean.
/// While the session compacts it shows a spinner instead of the needle and the menu is off.
struct TicketContextGauge: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @State private var confirm: Confirmation?
    @State private var limitSheet = false
    @State private var info: Info?
    @State private var failure: String?

    enum Info: Identifiable {
        case gauge, misses
        var id: Self { self }
    }

    private var limit: Int { store.state.settings?.contextLimit ?? ContextGaugeLimits.default }
    private var driver: DriverInfo? { store.state.drivers.first { $0.id == ticket.driver } }
    private var gauge: ContextGauge { ContextGauge(ticket: ticket, limit: limit) }
    private var compacting: Bool { ticket.compacting == true }

    /// Whether the header shows a gauge for this ticket.
    static func isShown(for ticket: Ticket, drivers: [DriverInfo]) -> Bool {
        ContextGauge.isShown(driver: drivers.first { $0.id == ticket.driver })
    }

    var body: some View {
        let gauge = gauge
        let menu = ContextGauge.menu(driver: driver, busy: ticket.busy, compacting: compacting)
        Menu {
            menuItems(gauge, menu)
        } label: {
            label(gauge)
        }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .disabled(!menu.opens)
        .accessibilityLabel(compacting ? "Context, compacting" : gauge.summary + (gauge.missBadge.map { ", \($0)" } ?? ""))
        .accessibilityHint("Opens the session menu")
        .accessibilityIdentifier("ticket-context-gauge")
        .popover(item: $info) { which in
            infoPopover(which, gauge)
                .presentationCompactAdaptation(.popover)
        }
        .sheet(isPresented: $limitSheet) { ContextLimitSheet(current: limit) }
        .confirmation($confirm)
        .alert("Couldn't change the session", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
    }

    // MARK: Label

    private func label(_ gauge: ContextGauge) -> some View {
        HStack(spacing: 5) {
            ContextDial(gauge: gauge, compacting: compacting)
                .frame(width: 34, height: 20)
                .overlay(alignment: .topTrailing) {
                    if let badge = gauge.missBadge {
                        Text(badge)
                            .font(.scaled(size: 9.5, weight: .bold))
                            .foregroundStyle(c.onAmber)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(c.amber, in: .capsule)
                            .fixedSize()
                            .offset(x: 12, y: -9)
                            .accessibilityIdentifier("ticket-context-misses")
                    }
                }
            Text(compacting ? "…" : gauge.label)
                .font(.scaled(size: 13, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(gauge.isEmpty ? c.text3 : gauge.isOver ? c.red : c.text2)
                .fixedSize()
        }
        .padding(.leading, 6)
        .padding(.trailing, gauge.missBadge == nil ? 2 : 12)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
    }

    // MARK: Menu

    @ViewBuilder private func menuItems(_ gauge: ContextGauge, _ menu: ContextGauge.Menu) -> some View {
        if let row = gauge.missRow {
            Button { info = .misses } label: {
                Label(row, systemImage: "info.circle")
            }
            Button { router.push(.driver(id: "claude-code")) } label: {
                Label("Claude Code settings…", systemImage: "gearshape")
            }
            Divider()
        }
        if menu.compact.isShown {
            action("Compact", "arrow.down.right.and.arrow.up.left", menu.compact) { run(.compact) }
        }
        if menu.newSession.isShown {
            action("New session", "arrow.counterclockwise", menu.newSession) {
                confirm = Confirmation(
                    title: "Start a new session?",
                    message: "The conversation is discarded. The next run starts fresh from the spec, Activity and branch.",
                    action: "New session"
                ) { run(.new) }
            }
        }
        Button { limitSheet = true } label: {
            Label("Limit…", systemImage: "gauge.with.dots.needle.33percent")
        }
        Divider()
        Button { info = .gauge } label: {
            Label("About this gauge", systemImage: "info.circle")
        }
    }

    /// A menu item, with the reason under it when it's greyed.
    @ViewBuilder private func action(_ title: String, _ icon: String, _ availability: ContextGauge.Availability, _ perform: @escaping () -> Void) -> some View {
        if case let .disabled(reason) = availability {
            Button(action: perform) {
                Text(title)
                Text(reason)
                Image(systemName: icon)
            }
            .disabled(true)
        } else {
            Button(title, systemImage: icon, action: perform)
        }
    }

    private func run(_ action: SessionActionBody.Action) {
        guard let api = store.api else { return }
        let key = ticket.key
        Task {
            do {
                let updated = try await api.sessionAction(key, action)
                haptic(.success)
                store.dispatch(.tickets([updated]))
            } catch {
                haptic(.error)
                failure = errorMessage(error)
            }
        }
    }

    // MARK: Info

    private func infoPopover(_ which: Info, _ gauge: ContextGauge) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(which == .gauge ? "Context gauge" : "Cache misses")
                .font(.scaled(size: 15, weight: .semibold))
            Text(which == .gauge ? gauge.info : ContextGauge.missInfo)
                .font(.scaled(size: 14))
                .foregroundStyle(c.text2)
                .fixedSize(horizontal: false, vertical: true)
            if which == .misses {
                Button("Claude Code settings") {
                    info = nil
                    router.push(.driver(id: "claude-code"))
                }
                .font(.scaled(size: 14, weight: .semibold))
            }
        }
        .padding(16)
        .frame(width: 300, alignment: .leading)
        .accessibilityIdentifier("ticket-context-info")
    }
}

/// The dial: a semicircle track with its red limit zone, the two-tone fill, the prefix tick, and the
/// needle (a spinner while compacting).
private struct ContextDial: View {
    let gauge: ContextGauge
    let compacting: Bool

    @Environment(\.palette) private var c

    /// Cached tokens: slate.
    static let slate = Color(red: 0.40, green: 0.48, blue: 0.58)

    var body: some View {
        ZStack {
            Canvas { ctx, size in
                let stroke: CGFloat = 5
                let radius = min(size.width / 2, size.height) - stroke / 2
                let center = CGPoint(x: size.width / 2, y: size.height - 1)
                func arc(_ from: Double, _ to: Double) -> Path {
                    Path { $0.addArc(center: center, radius: radius, startAngle: .degrees(180 + 180 * from), endAngle: .degrees(180 + 180 * to), clockwise: false) }
                }
                func line(_ style: Color, _ from: Double, _ to: Double) {
                    guard to > from else { return }
                    ctx.stroke(arc(from, to), with: .color(style), style: StrokeStyle(lineWidth: stroke, lineCap: .butt))
                }
                let empty = gauge.isEmpty
                line(empty ? c.border : c.borderStrong, 0, 1)
                line(c.red.opacity(empty ? 0.12 : 0.35), 0.9, 1)
                if gauge.isOver {
                    line(c.red, 0, 1)
                } else if gauge.isEstimated {
                    line(Self.slate, 0, gauge.fraction)
                } else {
                    line(Self.slate, 0, gauge.cachedFraction)
                    line(c.amber, gauge.cachedFraction, gauge.fraction)
                }
                // The starting prefix: a tick across the track.
                if let p = gauge.prefixFraction {
                    let a = Angle.degrees(180 + 180 * p).radians
                    let inner = CGPoint(x: center.x + (radius - stroke / 2 - 1.5) * cos(a), y: center.y + (radius - stroke / 2 - 1.5) * sin(a))
                    let outer = CGPoint(x: center.x + (radius + stroke / 2 + 1.5) * cos(a), y: center.y + (radius + stroke / 2 + 1.5) * sin(a))
                    ctx.stroke(Path { $0.move(to: inner); $0.addLine(to: outer) }, with: .color(c.text), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                }
                if !compacting {
                    let a = Angle.degrees(180 + 180 * gauge.fraction).radians
                    let tip = CGPoint(x: center.x + (radius - 1) * cos(a), y: center.y + (radius - 1) * sin(a))
                    let color = empty ? c.text3 : gauge.isOver ? c.red : c.text
                    ctx.stroke(Path { $0.move(to: center); $0.addLine(to: tip) }, with: .color(color), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    ctx.fill(Path(ellipseIn: CGRect(x: center.x - 2.5, y: center.y - 2.5, width: 5, height: 5)), with: .color(color))
                }
            }
            if compacting {
                ProgressView().controlSize(.mini).offset(y: 3)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Limit…: the gauge's limit, the same value as Settings → General. Accepts "250000", "250k", "1.5m".
struct ContextLimitSheet: View {
    let current: Int

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var c
    @State private var text = ""
    @FocusState private var focused: Bool

    private var parsed: Int? { SettingsRules.contextGaugeLimit(text) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Tokens", text: $text)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(save)
                        .accessibilityIdentifier("context-limit-field")
                } footer: {
                    Text("How many tokens the gauge counts up to: \(ContextGauge.tokens(ContextGaugeLimits.min))–\(ContextGauge.tokens(ContextGaugeLimits.max)). It's the same limit as in Settings, for every ticket.")
                }
            }
            .navigationTitle("Context limit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(parsed == nil).accessibilityIdentifier("context-limit-save")
                }
            }
        }
        .presentationDetents([.height(260)])
        .onAppear {
            text = String(current)
            focused = true
        }
    }

    private func save() {
        guard let limit = parsed, let api = store.api else { return }
        actions.perform { _ = try await api.updateSettings(SettingsPatch(contextGaugeLimit: limit)) }
        dismiss()
    }
}
