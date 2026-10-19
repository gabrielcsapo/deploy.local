import SwiftUI
import DeployCore
import MarkdownUI

/// The changed-file index and per-file diffs shared by task review, pull requests and the compare preview.
struct ReviewDiffList: View {
    let files: [ChangedFile]
    let patches: [ReviewFilePatch]
    let width: CGFloat
    let reader: ScrollViewProxy
    var emptyMessage = "No changes"
    @Environment(\.colorScheme) private var scheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var wrapLines = false
    private var isPhone: Bool { horizontalSizeClass == .compact }
    #else
    private var isPhone: Bool { false }
    #endif

    var body: some View {
        if files.isEmpty && patches.isEmpty {
            Label(emptyMessage, systemImage: "checkmark.circle").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 24) {
                VStack(spacing: 0) {
                    ForEach(files) { file in
                        let patch = patches.first { $0.path == file.path }
                        Button { reader.scrollTo(file.path, anchor: .top) } label: {
                            HStack(spacing: 10) {
                                WorkspaceGlyph(name: .file, size: 16).foregroundStyle(.secondary)
                                Text(file.path).lineLimit(isPhone ? 2 : 1).truncationMode(.middle)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                if !isPhone { Text(changedFileLabel(file.status)).font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
                                LineCounts(additions: patch?.additions ?? 0, deletions: patch?.deletions ?? 0)
                            }.font(WorkspaceStyle.navigation).padding(.vertical, 9).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .accessibilityLabel("Show diff for \(file.path), \(changedFileLabel(file.status)), \(patch?.additions ?? 0) additions, \(patch?.deletions ?? 0) deletions")
                        if file.id != files.last?.id { Divider().opacity(0.5) }
                    }
                }
                #if os(iOS)
                if isPhone {
                    Toggle("Wrap diff lines", isOn: $wrapLines).font(.subheadline)
                        .accessibilityHint("Wrap long lines to read without horizontal scrolling")
                }
                #endif
                ForEach(patches) { file in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Text(file.path).font(WorkspaceStyle.navigation.weight(.semibold)).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            LineCounts(additions: file.additions, deletions: file.deletions)
                        }
                        if file.lines.isEmpty {
                            Text("No text diff is available for this file.").font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                        } else {
                            #if os(iOS)
                            FilePatchView(file: file, minimumWidth: max(0, width), wrapLines: isPhone && wrapLines,
                                          isNewFile: files.contains { $0.path == file.path && ($0.status.contains("?") || $0.status.contains("A")) })
                            #else
                            FilePatchView(file: file, minimumWidth: max(0, width))
                            #endif
                        }
                    }.id(file.path)
                }
            }
        }
    }
}

struct LineCounts: View {
    let additions: Int
    let deletions: Int
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 6) {
            Text("+\(additions)").foregroundStyle(WorkspaceStyle.success(scheme))
            Text("−\(deletions)").foregroundStyle(WorkspaceStyle.danger(scheme))
        }.font(.system(.caption, design: .monospaced, weight: .medium)).fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(additions) additions, \(deletions) deletions")
    }
}

struct FilePatchView: View {
    let file: ReviewFilePatch
    let minimumWidth: CGFloat
    var wrapLines = false
    var isNewFile = false
    @Environment(\.colorScheme) private var scheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    private var visibleLines: [ReviewPatchLine] {
        #if os(iOS)
        let added = isNewFile || file.lines.contains { $0.kind == .metadata && $0.text.hasPrefix("new file mode ") }
        if horizontalSizeClass == .compact && added { return file.lines.filter { $0.kind != .hunk } }
        #endif
        return file.lines
    }
    private func color(_ kind: ReviewPatchLine.Kind) -> Color {
        kind == .addition ? WorkspaceStyle.success(scheme) : kind == .deletion ? WorkspaceStyle.danger(scheme) : kind == .hunk ? WorkspaceStyle.accent(scheme) : .primary
    }
    var body: some View {
        Group {
            if wrapLines { patchLines.frame(width: minimumWidth, alignment: .leading) }
            else {
                ScrollView(.horizontal) { patchLines }
                    #if os(iOS)
                    .scrollIndicators(.visible)
                    .overlay(alignment: .trailing) {
                        LinearGradient(colors: [.clear, WorkspaceStyle.canvas(scheme)], startPoint: .leading, endPoint: .trailing)
                            .frame(width: 18).allowsHitTesting(false)
                    }
                    #endif
            }
        }
        .background(WorkspaceStyle.surface(scheme).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(WorkspaceStyle.line(scheme).opacity(0.7), lineWidth: 1))
        .accessibilityLabel("Diff for \(file.path)")
    }
    private var patchLines: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(visibleLines.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    HStack(spacing: 4) {
                        Text(line.oldNumber.map(String.init) ?? "").frame(width: 28, alignment: .trailing)
                        Text(line.newNumber.map(String.init) ?? "").frame(width: 28, alignment: .trailing)
                    }.foregroundStyle(.secondary).accessibilityHidden(true)
                    #if os(iOS)
                    Text(line.kind == .metadata && line.text.hasPrefix("new file mode ") ? "New file" : line.text.isEmpty ? " " : line.text)
                        .foregroundStyle(color(line.kind)).textSelection(.enabled)
                        .fixedSize(horizontal: !wrapLines, vertical: wrapLines)
                        .frame(maxWidth: wrapLines ? .infinity : nil, alignment: .leading)
                    #else
                    Text(line.text.isEmpty ? " " : line.text).foregroundStyle(color(line.kind)).textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                    #endif
                    Spacer(minLength: 12)
                }.font(.system(.footnote, design: .monospaced)).padding(.vertical, 3).padding(.leading, 8)
                    .frame(minWidth: minimumWidth, alignment: .leading)
                    .background(line.kind == .addition || line.kind == .deletion ? color(line.kind).opacity(0.08) : line.kind == .hunk ? Color.primary.opacity(0.035) : .clear)
            }
        }.frame(minWidth: minimumWidth, alignment: .leading)
    }
}

/// A pipeline run with its jobs, the computer each ran on, and any deployment it produced.
struct PipelineRunView: View {
    let run: ProjectWorkItem
    let jobs: [WorkspaceJob]
    var workers: [Worker] = []
    var title: String? = nil
    var isCurrent = true
    @Environment(\.colorScheme) private var scheme

    private var tone: String { pipelineTone(run.status) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                ReviewStatusGlyph(status: run.status)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title ?? run.displayTitle).font(WorkspaceStyle.navigation.weight(.semibold)).lineLimit(2)
                    HStack(spacing: 6) {
                        Text(pipelineLabel(run.status)).foregroundStyle(WorkspaceStyle.tone(tone, scheme))
                        if let commit = run.commit { Text("·"); Text(String(commit.prefix(7))).font(.system(.caption, design: .monospaced)) }
                        if let date = workspaceDate(run.createdAt) { Text("·"); ReviewRelativeTime(date: date) }
                        if !isCurrent { Text("· earlier commit") }
                    }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                }
                Spacer(minLength: 0)
            }
            if !jobs.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(jobs) { job in PipelineJobRow(job: job, computer: computerName(job.workerId)) }
                }
            }
            if let deployment = run.deployment {
                DeploymentRow(deployment: deployment)
            }
        }
    }
    private func computerName(_ id: String?) -> String {
        guard let id else { return "Waiting for a computer" }
        return workers.first { $0.id == id }?.name ?? (id == "local" ? "This coordinator" : id)
    }
}

/// A pipeline job: name, result and the computer that ran it; the command and output expand in place.
struct PipelineJobRow: View {
    let job: WorkspaceJob
    let computer: String
    @State private var expanded = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var command: String { job.command.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { expanded.toggle() } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    ReviewStatusGlyph(status: job.status)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(job.name ?? command).font(WorkspaceStyle.navigation.weight(.medium))
                            .foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(1)
                        HStack(spacing: 6) {
                            Text(pipelineLabel(job.status)).foregroundStyle(WorkspaceStyle.tone(pipelineTone(job.status), scheme))
                            if let exit = job.exitCode, exit != 0 { Text("· Exit \(exit)") }
                            Text("·")
                            Image(systemName: "desktopcomputer").font(.caption2).accessibilityHidden(true)
                            Text(computer).lineLimit(1).truncationMode(.middle)
                        }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                        .foregroundStyle(WorkspaceStyle.tertiary(scheme))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .accessibilityHidden(true)
                }.padding(.vertical, 6).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(job.name ?? command), \(pipelineLabel(job.status)), on \(computer)")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    Text(command).font(.system(.caption, design: .monospaced)).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                        .textSelection(.enabled)
                    if let reason = job.waitingReason, !reason.isEmpty {
                        Text(reason).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    }
                    if !job.output.isEmpty {
                        ScrollView([.horizontal, .vertical]) {
                            Text(job.output).font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled).fixedSize(horizontal: true, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }.frame(height: min(240, CGFloat(job.output.components(separatedBy: "\n").count) * 16 + 24))
                            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
                    } else if job.isActive {
                        Text("Waiting for output…").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    }
                    if let error = job.error, !error.isEmpty {
                        Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme)).textSelection(.enabled)
                    }
                }.padding(.leading, WorkspaceStyle.iconWidth + 10)
            }
        }
        .animation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion), value: expanded)
    }
}

struct DeploymentRow: View {
    let deployment: PipelineDeployment
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            ReviewStatusGlyph(status: deployment.status == "succeeded" ? "succeeded" : deployment.status)
            VStack(alignment: .leading, spacing: 3) {
                Text("Deploy \(deployment.application)").font(WorkspaceStyle.navigation.weight(.medium))
                HStack(spacing: 6) {
                    Text(deployment.status == "succeeded" ? "Released" : pipelineLabel(deployment.status))
                        .foregroundStyle(WorkspaceStyle.tone(pipelineTone(deployment.status), scheme))
                    if let release = deployment.releaseId {
                        Text("·")
                        Text("Release \(release.prefix(8))").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                }.font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                if let failure = deployment.error { Text(failure).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme)).textSelection(.enabled) }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Status icon used in review rows; color always pairs with a shape so state never relies on hue alone.
struct ReviewStatusGlyph: View {
    let status: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let tone = pipelineTone(status)
        Image(systemName: tone == "healthy" ? "checkmark.circle.fill" : tone == "failed" ? "xmark.circle.fill" : tone == "active" ? "circle.dotted.circle" : "circle")
            .font(.system(.body, weight: .medium))
            .foregroundStyle(WorkspaceStyle.tone(tone, scheme))
            .frame(width: WorkspaceStyle.iconWidth)
            .accessibilityHidden(true)
    }
}

func pipelineTone(_ status: String) -> String {
    switch status {
    case "succeeded", "healthy", "merged": "healthy"
    case "failed", "timed_out", "error": "failed"
    case "queued", "waiting", "running", "cancelling", "starting", "publishing", "checking": "active"
    default: "inactive"
    }
}
func pipelineLabel(_ status: String) -> String {
    switch status {
    case "succeeded": "Passed"
    case "timed_out": "Timed out"
    case "waiting": "Waiting"
    default: status.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

/// The record's description and conversation, ending in a composer that matches the task prompt.
struct ReviewTimeline: View {
    let description: String?
    let author: String?
    let createdAt: String
    let comments: [ProjectComment]
    let busy: Bool
    let send: (String) async -> Bool
    @State private var draft = ""
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ReviewSectionHeading(title: "Activity", detail: comments.isEmpty ? nil : "\(comments.count) \(comments.count == 1 ? "comment" : "comments")")
            entry(author: author ?? "Author", date: createdAt, verb: "opened this", body: description, pending: false)
            ForEach(comments) { comment in
                entry(author: comment.author, date: comment.createdAt, verb: "commented", body: comment.body, pending: comment.id == "pending")
            }
            VStack(alignment: .leading, spacing: 8) {
                TextField("Comment", text: $draft, prompt: Text("Leave a comment…").foregroundColor(.primary.opacity(0.55)), axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(2...8).font(WorkspaceStyle.body)
                    .accessibilityLabel("Comment")
                HStack {
                    Text("Markdown supported").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    Spacer()
                    Button("Comment") { submit() }
                        .buttonStyle(.workspacePrimary)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding(14).modifier(WorkspacePromptSurface())
        }
    }

    private func submit() {
        let text = draft
        draft = ""
        Task { if !(await send(text)) { draft = text } }
    }

    private func entry(author: String, date: String, verb: String, body: String?, pending: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(String(author.prefix(1)).uppercased())
                .font(.system(.caption, weight: .bold)).foregroundStyle(WorkspaceStyle.accent(scheme))
                .frame(width: 28, height: 28).background(WorkspaceStyle.selected(scheme), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    Text(author).font(WorkspaceStyle.navigation.weight(.semibold))
                    Text(verb).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                    if pending { Text("· Sending…").foregroundStyle(WorkspaceStyle.secondaryText(scheme)) }
                    else if let created = workspaceDate(date) { Text("·").foregroundStyle(WorkspaceStyle.secondaryText(scheme)); ReviewRelativeTime(date: created).foregroundStyle(WorkspaceStyle.secondaryText(scheme)) }
                }.font(WorkspaceStyle.navigation).lineLimit(1)
                if let body, !body.isEmpty { Markdown(body).textSelection(.enabled) }
                else if verb == "opened this" { Text("No description provided.").foregroundStyle(WorkspaceStyle.secondaryText(scheme)).font(WorkspaceStyle.navigation) }
            }.opacity(pending ? 0.6 : 1)
            Spacer(minLength: 0)
        }.accessibilityElement(children: .combine)
    }
}

/// A linked coding task, so review and its conversation stay one step apart.
struct LinkedTaskRow: View {
    let task: WorkspaceTask?
    let id: String
    let open: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                WorkspaceGlyph(name: .chat, size: 18).foregroundStyle(WorkspaceStyle.accent(scheme))
                VStack(alignment: .leading, spacing: 3) {
                    Text(task?.title ?? "Task \(id.prefix(8))").font(WorkspaceStyle.navigation.weight(.medium)).lineLimit(2)
                        .foregroundStyle(WorkspaceStyle.text(scheme))
                    if let task { StatusBadge(status: task.status) }
                }
                Spacer(minLength: 8)
                Text("Open task").font(WorkspaceStyle.metadata.weight(.medium)).foregroundStyle(WorkspaceStyle.accent(scheme))
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }.contentShape(Rectangle()).padding(.vertical, 4)
        }.buttonStyle(.plain).accessibilityLabel("Open task \(task?.title ?? id)")
    }
}
