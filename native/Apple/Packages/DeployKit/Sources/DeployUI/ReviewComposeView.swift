import SwiftUI
import DeployCore

/// Composer for new pull requests, issues, edits and pipeline runs.
///
/// Inspired by Linear's issue composer (a borderless title, a quiet description and metadata chips in one
/// surface, with a single solid action) and GitHub's compare view (branch tokens with a live
/// ahead/behind verdict and the actual diff before anything is created).
struct ReviewComposeView: View {
    enum Mode: Equatable { case pull, issue, pipeline, edit }
    let mode: Mode
    @Bindable var model: ProjectReviewModel
    var tasks: [WorkspaceTask] = []
    var initialTaskIds: [String] = []
    let done: (Bool) -> Void

    @State private var title = ""
    @State private var bodyText = ""
    @State private var source = ""
    @State private var target = ""
    @State private var taskIds: [String] = []
    @State private var titleEdited = false
    @State private var suggestedTitle = ""
    @State private var comparison: BranchComparison?
    @State private var previewPatch = ""
    @State private var previewError: String?
    @State private var previewing = false
    @State private var prepared = false
    @FocusState private var titleFocused: Bool
    @Environment(\.colorScheme) private var scheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private var isPhone: Bool { horizontalSizeClass == .compact }
    #else
    private var isPhone: Bool { false }
    #endif

    private var actionTitle: String {
        switch mode {
        case .pull: "Create pull request"
        case .issue: "Create issue"
        case .pipeline: "Run pipeline"
        case .edit: "Save changes"
        }
    }
    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var blocker: String? {
        switch mode {
        case .pipeline: return target.isEmpty ? "Choose a branch to run." : nil
        case .issue, .edit: return trimmedTitle.isEmpty ? "Add a title." : nil
        case .pull:
            if source.isEmpty { return "Choose the branch with your changes." }
            if source == target { return "Choose two different branches." }
            if let comparison, comparison.ahead.isEmpty { return "\(source) has no commits that \(target) doesn’t already have." }
            if trimmedTitle.isEmpty { return "Add a title." }
            return nil
        }
    }
    private var previewFiles: [ChangedFile] { changedFiles(fromPatch: previewPatch) }
    private var previewPatches: [ReviewFilePatch] { reviewFilePatches(previewPatch, files: previewFiles) }

    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { reader in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Text(subtitle).font(WorkspaceStyle.navigation).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
                        if mode == .pull { compareBar }
                        if mode == .pipeline { pipelineBranch }
                        if mode != .pipeline { composer } else { footer.padding(.top, 4) }
                        if mode == .pull { preview(width: min(geometry.size.width, WorkspaceStyle.contentWidth) - (isPhone ? 32 : 48), reader: reader) }
                    }
                    .padding(isPhone ? 16 : 24)
                    .frame(maxWidth: WorkspaceStyle.contentWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .background(WorkspaceStyle.canvas(scheme))
        .onAppear(perform: prepare)
        .task(id: "\(source)→\(target)") { await loadPreview() }
    }

    private var subtitle: String {
        switch mode {
        case .pull: "Propose merging one branch into another. Checks and merge happen on the pull request."
        case .issue: "Capture the work. You can start a coding task from it when you’re ready."
        case .pipeline: "Runs deploy.yaml from the chosen branch on its configured computers."
        case .edit: "Update the title and description."
        }
    }

    private func prepare() {
        guard !prepared else { return }
        prepared = true
        let defaultBranch = model.repository?.defaultBranch ?? model.branches.first ?? "main"
        target = defaultBranch
        let targetOid = model.repository?.oid(ofBranch: defaultBranch)
        // Prefer a branch that actually differs from the target, so the first suggestion is mergeable work.
        source = model.branches.first { $0 != defaultBranch && model.repository?.oid(ofBranch: $0) != targetOid }
            ?? model.branches.first { $0 != defaultBranch } ?? ""
        taskIds = initialTaskIds
        if mode == .edit, let record = model.record {
            title = record.title ?? ""; bodyText = record.body ?? ""; titleEdited = true
        } else if let task = tasks.first(where: { initialTaskIds.contains($0.id) }), mode != .pipeline {
            title = taskTitle(task.title); titleEdited = true
        }
        // Focus after the field attaches; setting it during the first layout pass is ignored.
        if mode != .pipeline { Task { try? await Task.sleep(for: .milliseconds(150)); titleFocused = true } }
    }

    // MARK: Compare

    private var compareBar: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { compareTokens }
                VStack(alignment: .leading, spacing: 8) { compareTokens }
            }
            compareVerdict
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).modifier(ReviewPanel())
    }

    @ViewBuilder private var compareTokens: some View {
        HStack(spacing: 8) {
            Text("Merge").font(WorkspaceStyle.navigation).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            branchMenu(selection: $source, label: "Source branch", exclude: nil)
        }
        HStack(spacing: 8) {
            Text("into").font(WorkspaceStyle.navigation).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            branchMenu(selection: $target, label: "Target branch", exclude: nil)
        }
    }

    private func branchMenu(selection: Binding<String>, label: String, exclude: String?) -> some View {
        Menu {
            Picker(label, selection: selection) {
                ForEach(model.branches, id: \.self) { branch in Text(branch).tag(branch) }
            }.pickerStyle(.inline).labelsHidden()
        } label: {
            BranchToken(name: selection.wrappedValue, showsChevron: true)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .buttonStyle(.plain)
        .accessibilityLabel("\(label): \(selection.wrappedValue.isEmpty ? "none" : selection.wrappedValue)")
    }

    @ViewBuilder private var compareVerdict: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if source.isEmpty || source == target {
                verdict(icon: "arrow.triangle.branch", tone: "inactive", text: source.isEmpty ? "Choose the branch with your changes." : "Choose two different branches.")
            } else if previewing && comparison == nil {
                ProgressView().controlSize(.small)
                Text("Comparing \(source) with \(target)…").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            } else if let previewError {
                verdict(icon: "exclamationmark.triangle.fill", tone: "failed", text: previewError)
            } else if let comparison {
                if comparison.ahead.isEmpty {
                    verdict(icon: "equal.circle", tone: "inactive", text: "\(target) already contains everything on \(source).")
                } else if comparison.mergeBase == nil {
                    verdict(icon: "questionmark.circle", tone: "attention", text: "\(comparison.ahead.count)+ commits ahead. No shared history in the last 100 commits.")
                } else if comparison.fastForward {
                    verdict(icon: "checkmark.circle.fill", tone: "healthy", text: "\(count(comparison.ahead.count, "commit")) ahead of \(target). Can fast-forward merge.")
                } else {
                    verdict(icon: "exclamationmark.circle.fill", tone: "attention",
                            text: "\(count(comparison.ahead.count, "commit")) ahead, \(comparison.behind.count) behind \(target). Rebase \(source) before merging.")
                }
            }
        }
    }

    private func verdict(icon: String, tone: String, text: String) -> some View {
        Label { Text(text).foregroundStyle(WorkspaceStyle.text(scheme)) } icon: {
            Image(systemName: icon).foregroundStyle(WorkspaceStyle.tone(tone, scheme))
        }.font(WorkspaceStyle.metadata)
    }

    private func count(_ value: Int, _ noun: String) -> String { "\(value) \(noun)\(value == 1 ? "" : "s")" }

    private func loadPreview() async {
        guard mode == .pull else { return }
        comparison = nil; previewPatch = ""; previewError = nil
        guard !source.isEmpty, !target.isEmpty, source != target else { return }
        previewing = true
        defer { previewing = false }
        do {
            let (result, patch) = try await model.preview(source: source, target: target)
            guard !Task.isCancelled else { return }
            comparison = result; previewPatch = patch
            // Like GitHub, a single commit's subject becomes the suggested title until the person types one.
            if !titleEdited {
                suggestedTitle = result.ahead.count == 1 ? result.ahead[0].subject
                    : result.ahead.isEmpty ? "" : source.replacingOccurrences(of: "-", with: " ").capitalized
                title = suggestedTitle
            }
        } catch {
            if !Task.isCancelled { previewError = "Couldn’t compare these branches." }
        }
    }

    @ViewBuilder private func preview(width: CGFloat, reader: ScrollViewProxy) -> some View {
        if let comparison, !comparison.ahead.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ReviewSectionHeading(title: "Commits", detail: "\(comparison.ahead.count)")
                ForEach(comparison.ahead.prefix(20)) { commit in CommitRow(commit: commit) }
            }
            VStack(alignment: .leading, spacing: 12) {
                ReviewSectionHeading(title: "Files changed", detail: "\(previewFiles.count)")
                ReviewDiffList(files: previewFiles, patches: previewPatches, width: width, reader: reader)
            }
        }
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("Title", text: $title, prompt: Text(mode == .issue ? "Issue title" : "Pull request title").foregroundColor(.primary.opacity(0.4)), axis: .vertical)
                .textFieldStyle(.plain)
                .font(.title3.weight(.semibold))
                .lineLimit(1...3)
                .focused($titleFocused)
                .defaultFocus($titleFocused, mode != .pipeline)
                .onChange(of: title) { _, next in if next != suggestedTitle { titleEdited = !next.isEmpty } }
                .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 10)
                .accessibilityLabel("Title")
            TextField("Description", text: $bodyText, prompt: Text("Add a description…").foregroundColor(.primary.opacity(0.4)), axis: .vertical)
                .textFieldStyle(.plain)
                .font(WorkspaceStyle.body)
                .lineLimit(isPhone ? 4...12 : 5...16)
                .padding(.horizontal, 16).padding(.bottom, 14)
                .accessibilityLabel("Description")
            Divider().opacity(0.6)
            VStack(alignment: .leading, spacing: 12) {
                if mode != .edit {
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            taskChip
                            ComposerChip(icon: "text.badge.checkmark", title: "Markdown", isSet: false)
                                .accessibilityLabel("Description supports Markdown")
                        }
                    }.scrollIndicators(.hidden)
                }
                footer
            }.padding(12)
        }
        .modifier(ReviewPanel(emphasized: titleFocused))
    }

    private var taskChip: some View {
        let projectTasks = tasks
        let linked = projectTasks.first { taskIds.contains($0.id) }
        return Menu {
            Button { taskIds = [] } label: { if taskIds.isEmpty { Label("No task", systemImage: "checkmark") } else { Text("No task") } }
            if !projectTasks.isEmpty { Divider() }
            ForEach(projectTasks) { task in
                Button { taskIds = [task.id] } label: {
                    if taskIds.contains(task.id) { Label(task.title, systemImage: "checkmark") } else { Text(task.title) }
                }
            }
        } label: {
            ComposerChip(icon: "bubble.left.and.text.bubble.right", title: linked.map { "Task: \($0.title)" } ?? "Link a task", isSet: linked != nil)
                .frame(maxWidth: 280, alignment: .leading)
        }
        .menuIndicator(.hidden).buttonStyle(.plain).fixedSize()
        .accessibilityLabel(linked.map { "Linked task: \($0.title)" } ?? "Link a task")
    }

    private var pipelineBranch: some View {
        HStack(spacing: 10) {
            Text("Branch").font(WorkspaceStyle.navigation).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            branchMenu(selection: $target, label: "Branch", exclude: nil)
            Spacer(minLength: 0)
            if let oid = model.repository?.oid(ofBranch: target) {
                Text(String(oid.prefix(7))).font(.system(.caption, design: .monospaced)).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            }
        }.padding(14).modifier(ReviewPanel())
    }

    private var footer: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                blockerText
                Spacer(minLength: 8)
                Button("Cancel") { done(false) }.buttonStyle(.workspaceQuiet).keyboardShortcut(.cancelAction)
                submitButton
            }
            VStack(alignment: .leading, spacing: 10) {
                blockerText
                HStack(spacing: 10) {
                    Button("Cancel") { done(false) }.buttonStyle(.workspaceQuiet)
                    submitButton.frame(maxWidth: .infinity)
                }
            }
        }
    }

    @ViewBuilder private var blockerText: some View {
        if let error = model.error {
            Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(scheme)).lineLimit(3)
        } else if let blocker, mode == .pull || !trimmedTitle.isEmpty || mode == .pipeline {
            Text(blocker).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme)).lineLimit(2)
        } else {
            #if os(macOS)
            Text("⌘ Return").font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme))
            #endif
        }
    }

    private var submitButton: some View {
        Button {
            Task {
                let ok: Bool
                if mode == .edit { ok = await model.update(title: trimmedTitle, body: bodyText) }
                else { ok = await model.create(title: trimmedTitle, body: bodyText, source: source, target: target, taskIds: taskIds) }
                if ok { done(true) }
            }
        } label: {
            HStack(spacing: 8) {
                if model.busy { ProgressView().controlSize(.small).tint(WorkspaceStyle.onAction(scheme)) }
                Text(actionTitle)
            }
        }
        .buttonStyle(WorkspaceButtonStyle(variant: .primary, expands: isPhone))
        .keyboardShortcut(.return, modifiers: .command)
        .disabled(model.busy || blocker != nil)
    }
}

struct CommitRow: View {
    let commit: RepositoryCommit
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().strokeBorder(WorkspaceStyle.edge(scheme), lineWidth: 1.5).frame(width: 9, height: 9).accessibilityHidden(true)
            Text(commit.subject).font(WorkspaceStyle.navigation).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            Text(String(commit.oid.prefix(7))).font(.system(.caption, design: .monospaced))
                .foregroundStyle(WorkspaceStyle.secondaryText(scheme)).textSelection(.enabled)
        }.accessibilityElement(children: .combine)
    }
}
