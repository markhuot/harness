import HarnessKit
import SwiftUI

/// A chief's Listeners tab: the watchers it manages, read-only. Derived from the watchers the store
/// already holds, which the socket keeps current, so creating, editing, switching or deleting a
/// watcher updates the list with no refetch. To change a listener, ask the chief in its chat.
struct CosListenersView: View {
    let chief: Cos
    let onChat: () -> Void

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some View {
        let state = store.state
        let rows = Listeners.forChief(Array(state.watchers.values), chief: chief)
        let groups = state.projectGroups()
        let owner: (String) -> String? = { id in
            guard let other = store.cos.chiefs[id] else { return nil }
            let name = groups.first { CosLogic.scopeKey(groupId: $0.id) == other.scope }?.name
            return CosLogic.title(scope: other.scope, groupName: name)
        }
        VStack(spacing: 0) {
            HStack {
                Text("What this chief of staff listens to").font(.scaled(size: 13)).foregroundStyle(c.text3)
                Spacer()
                Button(action: onChat) { Label("Ask the chief", systemImage: "bubble.left").font(.scaled(size: 14, weight: .medium)) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityIdentifier("cos-listeners-ask")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            ScrollView {
                LazyVStack(spacing: 10) {
                    if rows.isEmpty {
                        VStack(spacing: 8) {
                            Icon("inbox", size: 22).foregroundStyle(c.text3)
                            Text("No listeners yet").font(.scaled(size: 15, weight: .semibold)).foregroundStyle(c.text2)
                            Text("Ask the chief of staff in chat to listen for something, like PR feedback or new errors, and it sets the listener up.")
                                .font(.scaled(size: 14)).foregroundStyle(c.text3).multilineTextAlignment(.center)
                        }
                        .padding(.vertical, 40)
                        .accessibilityIdentifier("cos-listeners-empty")
                    }
                    ForEach(rows) { w in
                        CosListenerRow(watcher: w, tag: Listeners.owner(w, viewer: chief, chiefName: owner))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
        .accessibilityIdentifier("cos-listeners")
    }
}

struct CosListenerRow: View {
    let watcher: Watcher
    let tag: String?

    @Environment(\.palette) private var c

    var body: some View {
        let w = watcher
        let status = Listeners.status(w)
        let error = Listeners.error(w)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(w.name).font(.scaled(size: 15, weight: .medium)).foregroundStyle(c.text).lineLimit(1)
                if let tag { Badge(tag).accessibilityIdentifier("cos-listener-owner") }
                Spacer(minLength: 0)
                Badge(status.label, tone: tone(status)).accessibilityIdentifier("cos-listener-status")
            }
            Text(Listeners.command(w)).font(.mono(12)).foregroundStyle(c.text2).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("cos-listener-command")
            if !error.isEmpty {
                Text(error).font(.scaled(size: 13)).foregroundStyle(c.red).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("cos-listener-error")
            }
            NowReader { now in
                var line = "\(Listeners.schedule(w)) · Last ran \(w.lastRunAt == nil ? "never" : Format.relativeTime(w.lastRunAt, now: now))"
                if let next = Listeners.nextRun(w) { line += " · Next run \(Listeners.until(next, now: now))" }
                return Text(line).font(.scaled(size: 12)).foregroundStyle(c.text3).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .background(c.bgElev, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("cos-listener")
    }

    private func tone(_ s: Listeners.Status) -> Tone {
        switch s {
        case .running: .accent
        case .active: .green
        case .error: .red
        case .paused: .neutral
        }
    }
}
