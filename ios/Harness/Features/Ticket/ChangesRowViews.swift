import HarnessHighlight
import HarnessKit
import SwiftUI

// The Changes tab's pieces: the overview card (refs, totals, commits, style and refresh), file
// list rows, each file's header (disclosure, status, counts, Viewed), collapsed-context gaps, and
// diff lines in the unified and split styles. Lines wrap rather than scroll sideways, so the diff
// can be one lazy list; add/del tints are full-width row backgrounds.

/// A changed file's status color and letter.
private func statusTone(_ s: ChangedFileStatus, _ c: Palette) -> (bg: Color, fg: Color) {
    switch s {
    case .added, .untracked: c.tone(.green)
    case .modified: c.tone(.amber)
    case .deleted: c.tone(.red)
    case .renamed: c.tone(.violet)
    case .unknown: c.tone(.neutral)
    }
}

private struct ChangesStatusBadge: View {
    let status: ChangedFileStatus
    @Environment(\.palette) private var c

    var body: some View {
        let t = statusTone(status, c)
        Text(ChangesRows.statusLetter(status))
            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
            .foregroundStyle(t.fg)
            .frame(width: 18, height: 18)
            .background(t.bg, in: .rect(cornerRadius: 4))
    }
}

/// "+3 −1" in the diff colors, or "bin" / "moved".
private struct ChangesDecoration: View {
    let file: ChangedFile
    @Environment(\.palette) private var c

    var body: some View {
        if let d = ChangesRows.decoration(file) {
            Group {
                if file.binary || (file.status == .renamed && file.additions == 0 && file.deletions == 0) {
                    Text(d.text).foregroundStyle(c.text3)
                } else {
                    Text("+\(file.additions)").foregroundStyle(c.green) + Text(" −\(file.deletions)").foregroundStyle(c.red)
                }
            }
            .font(.system(size: 12, weight: .medium, design: .monospaced))
            .lineLimit(1)
            .fixedSize()
        }
    }
}

// MARK: Overview

struct ChangesOverview: View {
    let model: ChangesStore
    let width: CGFloat

    @Environment(\.palette) private var c

    var body: some View {
        let changes = model.changes
        let commits = model.log?.commits ?? []
        VStack(alignment: .leading, spacing: 10) {
            refs(changes)
            if let changes, !changes.files.isEmpty {
                HStack(spacing: 8) {
                    Text("+\(changes.additions)").foregroundStyle(c.green)
                    Text("−\(changes.deletions)").foregroundStyle(c.red)
                    Text("across \(ChangesRows.plural(changes.files.count, "file"))").foregroundStyle(c.text2)
                    if !model.fingerprints.isEmpty {
                        Text("\(model.viewedCount) / \(model.fingerprints.count) viewed")
                            .foregroundStyle(c.text3)
                            .accessibilityLabel("\(model.viewedCount) of \(model.fingerprints.count) files viewed")
                    }
                }
                .font(.system(size: 13, weight: .medium))
                .accessibilityElement(children: .combine)
            }
            HStack(spacing: 8) {
                if changes?.mode == .branch || changes?.mode == .pinned {
                    Button {
                        withAnimation(.snappy) { model.showCommits.toggle() }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "smallcircle.filled.circle").font(.system(size: 11))
                            Text(ChangesRows.plural(commits.count, "commit"))
                            if !commits.isEmpty { Icon("chevronDown", size: 10).rotationEffect(.degrees(model.showCommits ? 180 : 0)) }
                        }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(model.showCommits ? c.accentText : c.text2)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(model.showCommits ? c.accentSoft : c.bgActive, in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .disabled(commits.isEmpty)
                    .accessibilityLabel(ChangesRows.plural(commits.count, "commit"))
                    .accessibilityHint(model.showCommits ? "Hides the commits" : "Shows the commits")
                }
                Spacer(minLength: 0)
                styleControl
                Button {
                    model.refresh()
                } label: {
                    Icon("refresh", size: 14)
                        .foregroundStyle(c.text2)
                        .rotationEffect(.degrees(model.loading ? 360 : 0))
                        .animation(model.loading ? .linear(duration: 0.9).repeatForever(autoreverses: false) : .default, value: model.loading)
                        .frame(width: 32, height: 30)
                        .background(c.bgActive, in: .rect(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh")
            }
            if model.chosenStyle == .split && model.style(width: Double(width)) == .unified {
                Text("Split needs a wider screen, so this shows unified.")
                    .font(.system(size: 12))
                    .foregroundStyle(c.text3)
            }
            if model.showCommits && !commits.isEmpty { commitList(commits) }
            ForEach(ChangesRows.notices(changes, error: model.error), id: \.self) { n in
                Callout(tone: .amber, icon: "alert", message: n) {} trailing: {}
            }
            if let e = model.expandError {
                Callout(tone: .red, icon: "alert", message: "Couldn't load the file: \(e)") {} trailing: {}
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.bgElev, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private func refs(_ changes: Changes?) -> some View {
        HStack(spacing: 6) {
            Icon("branch", size: 13).foregroundStyle(c.text3)
            switch changes?.mode {
            case .branch?:
                ref(changes?.branch ?? "HEAD")
                Text("→").foregroundStyle(c.text3)
                ref(changes?.base ?? "no base", base: true)
            case .pinned?:
                ref(changes?.branch ?? ChangesRows.short(changes?.head) ?? "HEAD")
                Text("→").foregroundStyle(c.text3)
                ref(ChangesRows.short(changes?.baseSha) ?? "no base", base: true)
                Badge("Saved", tone: .violet)
                    .accessibilityHint("The worktree is gone, so this is the diff saved while it existed")
            case nil:
                Text("Changes").foregroundStyle(c.text2)
            default:
                Text("Uncommitted on").foregroundStyle(c.text2)
                ref(changes?.branch ?? "HEAD")
            }
        }
        .font(.system(size: 13))
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }

    private func ref(_ name: String, base: Bool = false) -> some View {
        Text(name)
            .font(.mono(12.5, weight: .medium))
            .foregroundStyle(base ? c.text2 : c.text)
            .truncationMode(.middle)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(c.bgActive, in: .rect(cornerRadius: 5))
    }

    /// Unified/Split as labeled buttons (AXe reads a segmented Picker as one unlabeled element).
    private var styleControl: some View {
        let shown = model.chosenStyle ?? model.style(width: Double(width))
        return HStack(spacing: 2) {
            ForEach(ChangesDiffStyle.allCases, id: \.self) { s in
                let on = s == shown
                Button {
                    if !on { haptic(.select) }
                    model.setStyle(s)
                } label: {
                    Text(s == .unified ? "Unified" : "Split")
                        .font(.system(size: 12.5, weight: on ? .semibold : .medium))
                        .foregroundStyle(on ? c.text : c.text2)
                        .padding(.horizontal, 9)
                        .frame(height: 26)
                        .background(on ? c.bgElev : .clear, in: .rect(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(2)
        .background(c.bgActive, in: .rect(cornerRadius: 8))
    }

    private func commitList(_ commits: [ChangesCommit]) -> some View {
        let now = Date().timeIntervalSince1970 * 1000
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(commits) { commit in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(commit.shortSha).font(.mono(12, weight: .medium)).foregroundStyle(c.accentText)
                        Text(commit.subject).font(.system(size: 13.5)).foregroundStyle(c.text).lineLimit(2)
                    }
                    Text("\(commit.author) · \(ChangesRows.relTime(commit.date, now: now))")
                        .font(.system(size: 12))
                        .foregroundStyle(c.text3)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.bgSunken, in: .rect(cornerRadius: 8))
    }
}

// MARK: File list

struct ChangesFileListRow: View {
    let file: ChangedFile
    let viewed: Bool
    let onTap: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        let parts = file.path.split(separator: "/", omittingEmptySubsequences: false)
        let name = parts.last.map(String.init) ?? file.path
        let dir = parts.count > 1 ? parts.dropLast().joined(separator: "/") + "/" : ""
        Button(action: onTap) {
            HStack(spacing: 9) {
                ChangesStatusBadge(status: file.status)
                (Text(dir).foregroundStyle(c.text3) + Text(name).foregroundStyle(c.text))
                    .font(.mono(12.5))
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 4)
                if viewed { Icon("check", size: 12, weight: .bold).foregroundStyle(c.accent) }
                ChangesDecoration(file: file)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 34)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([file.path, file.status.rawValue, ChangesRows.decoration(file)?.label, viewed ? "viewed" : nil].compactMap(\.self).joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: File header

struct ChangesFileHeader: View {
    let file: ChangedFile
    let model: ChangesStore

    @Environment(\.palette) private var c

    var body: some View {
        let collapsed = model.isCollapsed(file.path)
        let viewed = model.isViewed(file.path)
        let canMark = model.fingerprints[file.path] != nil
        let shape = UnevenRoundedRectangle(topLeadingRadius: 10, topTrailingRadius: 10)
        HStack(spacing: 8) {
            Button {
                withAnimation(.snappy) { model.toggleCollapsed(file.path) }
            } label: {
                Icon("chevronRight", size: 11, weight: .bold)
                    .foregroundStyle(c.text3)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                    .frame(width: 24, height: 30)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!canMark)
            .accessibilityLabel("\(collapsed ? "Expand" : "Collapse") \(file.path)")
            ChangesStatusBadge(status: file.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(file.path).font(.mono(12.5, weight: .semibold)).foregroundStyle(c.text).lineLimit(2).truncationMode(.head)
                if let old = file.oldPath { Text("from \(old)").font(.mono(11)).foregroundStyle(c.text3).lineLimit(1).truncationMode(.head) }
            }
            Spacer(minLength: 4)
            ChangesDecoration(file: file)
            Button {
                haptic(.select)
                withAnimation(.snappy) { model.setViewed(file.path, !viewed) }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: viewed ? "checkmark.square.fill" : "square")
                        .font(.system(size: 14))
                        .foregroundStyle(viewed ? c.accent : c.text3)
                    Text("Viewed").font(.system(size: 12.5, weight: .medium)).foregroundStyle(viewed ? c.text : c.text2)
                }
                .padding(.horizontal, 7)
                .frame(height: 28)
                .background(viewed ? c.accentSoft : .clear, in: .rect(cornerRadius: 7))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!canMark)
            .accessibilityLabel("Viewed")
            .accessibilityValue(viewed ? "On" : "Off")
            .accessibilityHint("Marks \(file.path) as viewed and collapses it")
        }
        .padding(.leading, 4)
        .padding(.trailing, 8)
        .padding(.vertical, 5)
        .background(c.bgElev, in: shape)
        .overlay(shape.strokeBorder(c.border, lineWidth: 1 / 3))
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
        .padding(.horizontal, 10)
        .id("file:\(file.path)")
    }
}

// MARK: Gaps

struct ChangesGapRow: View {
    let gap: ChangesGap
    let loading: Bool
    let onExpand: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        let label = gap.count.map { "Show \(ChangesRows.plural($0, "unmodified line"))" } ?? "Show lines below"
        Button(action: onExpand) {
            HStack(spacing: 8) {
                if loading { Spinner().controlSize(.mini) } else { Icon("expand", size: 11).foregroundStyle(c.accentText) }
                Text(gap.count.map { ChangesRows.plural($0, "unmodified line") } ?? "Lines below")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(c.accentText)
                if let ctx = gap.context, !ctx.isEmpty {
                    Text(ctx).font(.mono(11.5)).foregroundStyle(c.text3).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.accentSoft.opacity(0.5))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: Lines

/// Line backgrounds on the card: the theme's git colors mixed into it (HighlightColors.diffTints).
private func lineTints(_ result: Highlighted?, _ c: Palette) -> (add: Color, del: Color) {
    let git = result?.git ?? HighlightColors.gitColors(nil, c.appearance)
    let t = try? HighlightColors.diffTints(c.tokens.bgElev, git, c.appearance)
    return (t.flatMap { Color(css: $0.add) } ?? c.diffAddSoft, t.flatMap { Color(css: $0.del) } ?? c.diffDelSoft)
}

private func sign(_ kind: ChangesLineKind) -> String {
    switch kind {
    case .add: "+"
    case .del: "-"
    case .ctx: " "
    }
}

private func lineText(_ line: ChangesLine, _ highlighted: HighlightedLine?, _ result: Highlighted?, _ c: Palette) -> AttributedString {
    let kind: DiffLineKind = line.kind == .add ? .add : line.kind == .del ? .del : .ctx
    let hl = highlighted ?? HighlightedLine(spans: [HighlightSpan(text: sign(line.kind)), HighlightSpan(text: line.text)], kind: kind)
    var text = HighlightedText.line(hl, style: HighlightedText.style(result, tokens: c.tokens, appearance: c.appearance))
    if line.text.isEmpty { text.append(AttributedString(" ")) }
    return text
}

struct ChangesLineRow: View {
    let line: ChangesLine
    let highlighted: HighlightedLine?
    let result: Highlighted?
    let gutter: CGFloat

    @Environment(\.palette) private var c

    var body: some View {
        let tints = lineTints(result, c)
        let n = line.kind == .del ? line.oldLine : line.newLine
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(n.map(String.init) ?? "")
                .font(.mono(11))
                .foregroundStyle(c.text3)
                .frame(width: gutter, alignment: .trailing)
                .padding(.trailing, 8)
            Text(lineText(line, highlighted, result, c))
                .font(HighlightedText.font)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 1.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(line.kind == .add ? tints.add : line.kind == .del ? tints.del : c.bgElev)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(line.kind == .add ? "Added" : line.kind == .del ? "Removed" : "Line") \(n.map(String.init) ?? ""): \(line.text)")
    }
}

struct ChangesSplitLineRow: View {
    let row: ChangesSplitRow
    let highlighted: Highlighted?
    let gutter: CGFloat

    @Environment(\.palette) private var c

    var body: some View {
        let tints = lineTints(highlighted, c)
        HStack(alignment: .top, spacing: 0) {
            side(row.old, code: row.oldCode, number: row.old?.oldLine, tint: tints.del)
            Rectangle().fill(c.border).frame(width: 1 / 3)
            side(row.new, code: row.newCode, number: row.new?.newLine, tint: tints.add)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func side(_ line: ChangesLine?, code: Int?, number: Int?, tint: Color) -> some View {
        let hl = code.flatMap { i in highlighted.flatMap { i < $0.lines.count ? $0.lines[i] : nil } }
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            if let line {
                Text(number.map(String.init) ?? "")
                    .font(.mono(11))
                    .foregroundStyle(c.text3)
                    .frame(width: gutter, alignment: .trailing)
                    .padding(.trailing, 6)
                Text(lineText(line, hl, highlighted, c))
                    .font(HighlightedText.font)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 1.5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(line == nil ? c.bgSunken : line?.kind == .ctx ? c.bgElev : tint)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.map { "\($0.kind == .add ? "Added" : $0.kind == .del ? "Removed" : "Line") \(number.map(String.init) ?? ""): \($0.text)" } ?? "")
        .accessibilityHidden(line == nil)
    }
}
