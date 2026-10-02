import HarnessKit
import SwiftUI

/// The Inbox section (the sidebar button switches back): every watcher and what its process is doing, then the triage
/// sessions their output started, newest first. A watcher opens its form; a session pushes
/// `.triage(sessionId:)`.
struct InboxScreen: View {
    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        let state = store.state
        let sessions = state.triageSessions()
        let watchers = InboxLogic.sortedWatchers(Array(state.watchers.values))
        ScrollView {
            LazyVStack(spacing: 0) {
                if !watchers.isEmpty {
                    NowReader(interval: .live) { now in
                        VStack(spacing: 0) {
                            ForEach(Array(watchers.enumerated()), id: \.element.id) { i, w in
                                InboxWatcherRow(watcher: w, now: now, first: i == 0)
                            }
                        }
                    }
                    .background(c.bgElev)
                    .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
                }
                if sessions.isEmpty {
                    EmptyState(icon: "inbox", title: "Inbox zero", message: "Output from watchers is triaged here before it becomes tickets.")
                        .padding(.top, 40)
                } else {
                    NowReader { now in
                        VStack(spacing: 0) {
                            ForEach(sessions) { s in
                                InboxSessionRow(session: s, now: now) { router.push(.triage(sessionId: s.id)) }
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 100)
        }
        .refreshable { await store.refresh() }
        .navigationTitle("Inbox")
        .navigationBarTitleDisplayMode(.large)
        .toolbar { SidebarToolbarItem() }
        .safeAreaInset(edge: .top) { ConnectionBanner() }
    }
}

/// The triage badge: a spinner while the session is busy, then its status.
struct InboxTriageBadge: View {
    let session: Session

    var body: some View {
        let t = InboxLogic.triageLabel(session)
        HStack(spacing: 4) {
            if session.busy { Spinner().controlSize(.small) }
            Badge(t.label, tone: Tone(rawValue: t.tone.rawValue) ?? .neutral)
        }
    }
}

private struct InboxSessionRow: View {
    let session: Session
    let now: Double
    let onOpen: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        let s = session
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(s.key).font(.mono(12.5)).foregroundStyle(c.text3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(Format.relativeTime(s.createdAt, now: now)).font(.scaled(size: 12.5)).foregroundStyle(c.text3)
                }
                Text(s.title.isEmpty ? "Untitled item" : s.title).font(.scaled(size: 16, weight: .medium)).foregroundStyle(c.text)
                    .lineLimit(2).multilineTextAlignment(.leading)
                HStack(spacing: 8) {
                    InboxTriageBadge(session: s)
                    if let outcome = s.outcome, !outcome.isEmpty {
                        Text(outcome).font(.scaled(size: 13)).foregroundStyle(c.text3).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(TranscriptPressedRowStyle())
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
    }
}

/// A watcher: status dot, name, schedule and status badges, what it's doing, and its last error
/// (with Retry now while it isn't running). Paused ones are muted, as in Settings.
private struct InboxWatcherRow: View {
    let watcher: Watcher
    let now: Double
    let first: Bool

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var expanded = false

    var body: some View {
        let w = watcher
        let s = Watchers.watcherStatus(w, now: now)
        let dot = s.tone == .green ? c.green : s.tone == .red ? c.red : c.text3
        VStack(alignment: .leading, spacing: 4) {
            Button(action: edit) {
                HStack(spacing: 8) {
                    Circle().fill(dot).frame(width: 8, height: 8)
                    Text(w.name).font(.scaled(size: 15, weight: .medium)).foregroundStyle(c.text).lineLimit(1)
                    Badge(InboxLogic.scheduleLabel(w))
                    Spacer(minLength: 0)
                    Badge(s.label, tone: Tone(rawValue: s.tone.rawValue) ?? .neutral)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            HStack(spacing: 8) {
                Text(s.detail).font(.scaled(size: 12.5)).foregroundStyle(c.text3).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                    .onTapGesture(perform: edit)
                if InboxLogic.showsRetry(w, status: s) {
                    HButton("Retry now", icon: "play", small: true, fullWidth: false) {
                        let name = w.name
                        actions.perform("Restarting \(name)") { _ = try await store.connectedAPI().runWatcher(w.id) }
                    }
                }
            }
            .padding(.leading, 16)
            if let error = s.error {
                Button {
                    expanded.toggle()
                } label: {
                    Text(error).font(.mono(11.5)).foregroundStyle(c.red).lineLimit(expanded ? nil : 2)
                        .multilineTextAlignment(.leading)
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(c.redSoft, in: .rect(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .padding(.leading, 16)
                .accessibilityLabel(expanded ? "Show less" : "Show the full error")
                .accessibilityValue(error)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .opacity(w.enabled ? 1 : 0.55)
        .overlay(alignment: .top) { if !first { Rectangle().fill(c.border).frame(height: 1 / 3) } }
    }

    private func edit() { router.present(.watcher(id: watcher.id)) }
}
