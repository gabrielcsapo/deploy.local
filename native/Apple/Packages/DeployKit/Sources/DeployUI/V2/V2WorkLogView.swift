#if os(iOS)
import SwiftUI
import DeployCore

/// An agent's steps between messages: "Worked for 14m", then one line a step.
struct V2WorkLogView: View {
    var log: WorkLogEvent
    /// The coordinator's address, for links like /dashboard/tally/build.
    var origin: String
    @State private var open: Bool
    @Environment(\.colorScheme) private var scheme

    init(log: WorkLogEvent, origin: String) {
        self.log = log
        self.origin = origin
        _open = State(initialValue: V2WorkLog.startsOpen(log))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    if log.live { V2StepSpinner() }
                    Text(log.summary).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                    if !log.live {
                        Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 11, weight: .medium)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                    }
                }.frame(minHeight: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(log.steps.enumerated()), id: \.offset) { _, step in V2WorkStepRow(step: step, origin: origin) }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(WorkspaceStyle.line(scheme)).frame(width: 1) }
                .padding(.leading, 8)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One step: icon or spinner · text · outcome, and the reason and log lines when opened.
struct V2WorkStepRow: View {
    var step: WorkStep
    var origin: String
    @State private var open: Bool
    @Environment(\.colorScheme) private var scheme

    init(step: WorkStep, origin: String) {
        self.step = step
        self.origin = origin
        _open = State(initialValue: V2WorkLog.stepStartsOpen(step))
    }

    private var opens: Bool { V2WorkLog.opens(step) }
    private var outcomeColor: Color {
        switch step.tone {
        case "fail": WorkspaceStyle.danger(scheme)
        case "warn": WorkspaceStyle.warning(scheme)
        default: WorkspaceStyle.tertiary(scheme)
        }
    }
    private var symbol: String {
        if step.glyph == "deploy" { return "tray.and.arrow.up" }
        switch step.icon {
        case .file: return "doc"
        case .edit: return "pencil"
        case .terminal: return "apple.terminal"
        case .pulse: return "waveform.path.ecg"
        case .logs: return "list.bullet.rectangle"
        case .search: return "magnifyingglass"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) { // the board's 2pt above an opened step
            if opens {
                // A tap rather than a Button, so an outcome link on the line still opens its page.
                line.onTapGesture { withAnimation(.snappy(duration: 0.2)) { open.toggle() } }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityValue(open ? "Expanded" : "Collapsed")
                    .accessibilityAction { open.toggle() }
            } else { line }
            if open && opens { detail }
        }
    }

    private var line: some View {
        HStack(spacing: 8) {
            Group {
                if step.live == true { V2StepSpinner() }
                else { Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme)) }
            }.frame(width: 16)
            Text(step.text).font(.system(size: 15)).foregroundStyle(WorkspaceStyle.secondary(scheme)).lineLimit(1).truncationMode(.tail)
                .layoutPriority(1)
            if step.added != nil || step.removed != nil {
                HStack(spacing: 4) {
                    if let added = step.added { Text("+\(Int(added))").foregroundStyle(WorkspaceStyle.success(scheme)) }
                    if let removed = step.removed { Text("−\(Int(removed))").foregroundStyle(WorkspaceStyle.danger(scheme)) }
                }.font(.system(size: 13)).fixedSize()
            }
            if let outcome = step.outcome, !outcome.isEmpty {
                if let href = step.outcomeHref, let url = V2WorkLog.url(href, origin: origin) {
                    Link(destination: url) { Text(outcome).underline() }
                        .font(.system(size: 13)).foregroundStyle(outcomeColor).lineLimit(1)
                } else {
                    Text(outcome).font(.system(size: 13)).foregroundStyle(outcomeColor).lineLimit(1)
                }
            }
            if opens {
                Spacer(minLength: 0)
                Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
            }
        }
        // The board's 22pt line. A row that opens keeps a 44pt tap target by reaching 11pt past
        // its edges, without making the visible row taller.
        .frame(height: 22)
        .contentShape(Rectangle().inset(by: opens ? -11 : 0))
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let reason = step.reason, !reason.isEmpty {
                Text(reason).font(.system(size: 15)).lineSpacing(4).foregroundStyle(WorkspaceStyle.secondary(scheme)).textSelection(.enabled)
            }
            if let tail = step.tail, !tail.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(tail.joined(separator: "\n")).font(.system(size: 12, design: .monospaced)).lineSpacing(4)
                        .foregroundStyle(WorkspaceStyle.tertiary(scheme)).fixedSize().textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                }
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
            }
            if let link = step.links?.first, let url = V2WorkLog.url(link.href, origin: origin) {
                Link(link.label, destination: url).font(.system(size: 15)).foregroundStyle(WorkspaceStyle.text(scheme))
                    .frame(height: 22).contentShape(Rectangle().inset(by: -11))
            }
        }.padding(.leading, 24).padding(.bottom, 6)
    }
}

/// The small spinner a running log and step show.
struct V2StepSpinner: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ProgressView().controlSize(.mini).tint(WorkspaceStyle.active(scheme)).frame(width: 14, height: 14)
            .accessibilityLabel("Running")
    }
}
#endif
