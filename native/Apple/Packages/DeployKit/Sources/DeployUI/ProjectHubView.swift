import SwiftUI
import DeployCore
import MarkdownUI

@MainActor
struct ProjectHubView: View {
    let project: Project
    let connection: Connection
    var isPushed = false
    let openTask: (String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private var isPhone: Bool { horizontalSizeClass == .compact && isPushed }
    #else
    private var isPhone: Bool { false }
    #endif
    @State private var section = "repository"
    @State private var projectColumn: NavigationSplitViewColumn = .detail
    @State private var items: [ProjectWorkItem] = []
    @State private var selected = ""
    @State private var detail: ProjectWorkResponse?
    @State private var comparison: PullComparison?
    @State private var repository: RepositoryInfo?
    @State private var creating = false
    @State private var editing = false
    @State private var title = ""
    @State private var bodyText = ""
    @State private var comment = ""
    @State private var source = ""
    @State private var target = "main"
    @State private var error: String?
    @State private var busy = false
    @State private var pendingCommands: [String: String] = [:]
    private var base: String { "/api/workspace/projects/\(project.id)" }
    private var branches: [String] { (repository?.refs ?? []).filter { $0.name.hasPrefix("refs/heads/") }.map { String($0.name.dropFirst(11)) } }

    var body: some View {
        Group {
            #if os(iOS)
            if isPhone { phoneHub }
            else { splitHub }
            #else
            splitHub
            #endif
        }
        .tint(WorkspaceStyle.accent(colorScheme))
        #if os(macOS)
        .frame(minWidth: 720, idealWidth: 860, minHeight: 560, idealHeight: 680)
        #endif
        .task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(2.5))
            }
        }
        .onChange(of: section) { _, _ in selected = ""; detail = nil; comparison = nil; creating = false; editing = false; items = []; error = nil; Task { await refresh() } }
        .onChange(of: selected) { _, _ in detail = nil; comparison = nil; Task { await refresh() } }
    }

    private var splitHub: some View {
        NavigationSplitView(preferredCompactColumn: $projectColumn) {
            List {
                projectSection("Files", id: "repository", icon: .folder)
                projectSection("Issues", id: "issues", icon: .circle)
                projectSection("Pull requests", id: "pulls", icon: .pullRequest)
                projectSection("Pipelines", id: "pipelines", icon: .terminal)
            }
            .listStyle(.sidebar)
            .navigationTitle(project.name)
            .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 280)
        } detail: {
            VStack(spacing: 0) {
                if let error { Text(error).font(.callout).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal) }
                if section == "repository" { repositoryView }
                else if creating { creationView }
                else if !selected.isEmpty { detailView }
                else { listView }
            }
            .navigationTitle(sectionTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    if section != "repository" && selected.isEmpty && !creating {
                        Button(section == "pipelines" ? "Run pipeline" : section == "pulls" ? "New pull request" : "New issue") {
                            title = ""; bodyText = ""; source = branches.first(where: { $0 != repository?.defaultBranch }) ?? ""; target = repository?.defaultBranch ?? "main"; editing = false; creating = true
                        }.disabled(busy)
                    }
                }
            }
        }
    }
    private var createTitle: String { section == "pipelines" ? "Run pipeline" : section == "pulls" ? "New pull request" : "New issue" }
    private func beginCreation() {
        title = ""; bodyText = ""; source = branches.first(where: { $0 != repository?.defaultBranch }) ?? ""
        target = repository?.defaultBranch ?? "main"; editing = false; creating = true
    }
    #if os(iOS)
    private var phoneHub: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    phoneChip("Issues", id: "issues")
                    phoneChip("Pull requests", id: "pulls")
                    phoneChip("Pipelines", id: "pipelines")
                    phoneChip("Repository", id: "repository")
                }.padding(.horizontal, 16).padding(.vertical, 10)
            }.scrollIndicators(.hidden).fixedSize(horizontal: false, vertical: true)
            if let error { Text(error).font(.callout).foregroundStyle(WorkspaceStyle.danger(colorScheme)).padding(.horizontal) }
            if section == "repository" { repositoryView }
            else { listView }
        }
        .navigationTitle(project.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if section != "repository" { Button(createTitle) { beginCreation() }.disabled(busy) }
            }
        }
        .navigationDestination(isPresented: Binding(get: { !selected.isEmpty }, set: { if !$0 { selected = "" } })) {
            detailView.navigationTitle(sectionTitle).navigationBarTitleDisplayMode(.inline)
                .navigationDestination(isPresented: $creating) { creationView.navigationTitle(editing ? "Edit" : createTitle) }
        }
        .navigationDestination(isPresented: Binding(get: { creating && selected.isEmpty }, set: { if !$0 { creating = false } })) {
            creationView.navigationTitle(createTitle).navigationBarTitleDisplayMode(.inline)
        }
    }
    private func phoneChip(_ title: String, id: String) -> some View {
        Button { section = id } label: {
            Text(title).font(.subheadline.weight(.medium)).fixedSize()
                .padding(.horizontal, 16).frame(minHeight: 44)
                .foregroundStyle(section == id ? WorkspaceStyle.canvas(colorScheme) : WorkspaceStyle.accent(colorScheme))
                .background(section == id ? WorkspaceStyle.accent(colorScheme) : WorkspaceStyle.raised(colorScheme), in: Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(section == id ? .isSelected : [])
    }
    #endif
    private var sectionTitle: String {
        switch section {
        case "issues": "Issues"
        case "pulls": "Pull requests"
        case "pipelines": "Pipelines"
        case "deployment": "Deployment"
        default: "Files"
        }
    }
    private func projectSection(_ title: String, id: String, icon: WorkspaceGlyphName) -> some View {
        Button {
            section = id
            projectColumn = .detail
        } label: {
            HStack(spacing: 10) {
                WorkspaceGlyph(name: icon, size: 18)
                Text(title)
                Spacer(minLength: 0)
            }
            .foregroundStyle(section == id ? WorkspaceStyle.accent(colorScheme) : .primary)
            .padding(.vertical, 7).padding(.horizontal, 8)
            .background(section == id ? WorkspaceStyle.selected(colorScheme) : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(section == id ? .isSelected : [])
    }
    private var listView: some View {
        List {
            if items.isEmpty {
                #if os(iOS)
                if isPhone {
                    ContentUnavailableView {
                        Label("No \(sectionTitle.lowercased())", systemImage: section == "pipelines" ? "terminal" : section == "pulls" ? "arrow.triangle.pull" : "circle")
                    } description: {
                        Text(section == "pipelines" ? "Define a pipeline in deploy.yaml, then run it here." : section == "pulls" ? "Open a pull request to review a branch." : "Capture work and start a coding task when you’re ready.")
                    } actions: { Button(createTitle) { beginCreation() }.disabled(busy) }
                } else {
                    legacyEmptyState
                }
                #else
                legacyEmptyState
                #endif
            }
            ForEach(items) { item in
                Button { selected = item.id } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: item.status == "succeeded" || item.status == "merged" ? "checkmark.circle" : item.status == "failed" ? "exclamationmark.circle" : "circle").foregroundStyle(.secondary).padding(.top, 2)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.displayTitle).font(.body.weight(.medium)).foregroundStyle(.primary).lineLimit(isPhone ? 2 : nil)
                            if isPhone { StatusBadge(status: item.status) }
                            else { Text((item.number.map { "#\($0) · " } ?? "") + item.status.capitalized).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }.padding(.vertical, 8).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
        }.listStyle(.plain)
    }
    private var legacyEmptyState: some View {
        Text(section == "pipelines" ? "Define a pipeline in deploy.yaml, then run it here or push a commit." : section == "pulls" ? "Open a pull request to review and merge a branch." : "Capture work here, then start a coding task when you’re ready.").foregroundStyle(.secondary).padding(.vertical, 24)
    }
    private var repositoryView: some View {
        RepositoryBrowserView(projectId: project.id, connection: connection, repository: repository) {
            perform { let _: JSONValue = try await request("/repository/retry", body: [:]) }
        }
    }
    private var creationView: some View {
        Form {
            Section {
                if section == "pipelines" {
                    Picker("Branch", selection: $target) { ForEach(branches, id: \.self) { Text($0).tag($0) } }
                } else {
                    TextField("Title", text: $title)
                    VStack(alignment: .leading) { Text("Description").font(.caption).foregroundStyle(.secondary); TextEditor(text: $bodyText).frame(minHeight: 150) }
                }
                if section == "pulls" && !editing {
                    Picker("Source", selection: $source) { Text("Choose branch").tag(""); ForEach(branches, id: \.self) { Text($0).tag($0) } }
                    Picker("Target", selection: $target) { ForEach(branches, id: \.self) { Text($0).tag($0) } }
                }
                HStack {
                    Button("Cancel") { creating = false }
                    Spacer()
                    Button(section == "pipelines" ? "Run pipeline" : editing ? "Save changes" : "Create") { perform {
                        var body: [String: JSONValue] = section == "pipelines" ? ["ref": .string(target)] : ["title": .string(title), "body": .string(bodyText)]
                        if section == "pulls" && !editing { body["sourceBranch"] = .string(source); body["targetBranch"] = .string(target) }
                        if editing { body["revision"] = .number(Double(detail?.record?.revision ?? 0)) }
                        let result: ProjectWorkItem = try await request(editing ? "/\(section)/\(selected)/update" : "/\(section)", body: body)
                        creating = false; editing = false; selected = result.id
                    } }.buttonStyle(.borderedProminent).disabled(busy || (section != "pipelines" && title.trimmingCharacters(in: .whitespaces).isEmpty) || (section == "pulls" && !editing && source == target))
                }
            }
        }.formStyle(.grouped)
    }
    private var detailView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if !isPhone { Button { selected = "" } label: { Label("Back", systemImage: "chevron.left") }.buttonStyle(.plain) }
                if let detail, let item = detail.record ?? detail.pipeline {
                    VStack(alignment: .leading, spacing: 8) {
                        if isPhone { StatusBadge(status: item.status) }
                        else { Text((item.number.map { "#\($0) · " } ?? "") + item.status.capitalized).font(.caption).foregroundStyle(.secondary) }
                        Text(item.displayTitle).font(.title2.weight(.semibold))
                        if let source = item.sourceBranch, let target = item.targetBranch { Text("\(source) → \(target)").font(.callout).foregroundStyle(.secondary) }
                    }
                    if let description = item.body, !description.isEmpty { Markdown(description).textSelection(.enabled) }
                    if section == "pipelines" {
                        if !["succeeded", "failed", "cancelled"].contains(item.status) { Button("Cancel run") { perform { let _: ProjectWorkItem = try await request("/pipelines/\(selected)/cancel", body: [:]) } } }
                        ForEach(detail.jobs ?? []) { job in
                            DisclosureGroup {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(job.command).font(.caption.monospaced())
                                    #if os(iOS)
                                    PhoneIdentifier(title: "Job", value: job.id)
                                    PhoneIdentifier(title: "Checkpoint", value: job.digest)
                                    #endif
                                    if let reason = job.waitingReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
                                    Text(job.output.isEmpty ? job.error ?? "No output yet" : job.output).font(.caption.monospaced()).textSelection(.enabled)
                                }.padding(.top, 10)
                            } label: {
                                VStack(alignment: .leading) {
                                    #if os(iOS)
                                    Text(job.name ?? job.command).font(.body.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                                    #else
                                    Text(job.name ?? job.command).font(.body.weight(.medium))
                                    #endif
                                    if isPhone {
                                        StatusBadge(status: job.status)
                                        Text(job.workerId ?? "Waiting for computer").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    } else {
                                        Text("\(job.workerId ?? "Waiting for computer") · \(job.status)").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .padding(14).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        }
                        if let deployment = item.deployment {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Deployment").font(.headline)
                                Text("\(deployment.application) · \(deployment.status)")
                                if let release = deployment.releaseId {
                                    #if os(iOS)
                                    PhoneIdentifier(title: "Release", value: release)
                                    #else
                                    Text("Release \(release)").font(.caption.monospaced()).textSelection(.enabled)
                                    #endif
                                }
                                if let failure = deployment.error { Text(failure).font(.caption).foregroundStyle(.red) }
                            }.padding(14).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        }
                    } else {
                        recordActions(item)
                        ForEach(item.taskIds ?? [], id: \.self) { task in Button("Open linked task") { openLinkedTask(task) } }
                        if let operation = detail.mergeOperation, let failure = operation.error { Text(failure).foregroundStyle(.red); if operation.status == "unknown" { Button("Recover merge") { perform { let _: ProjectWorkItem = try await request("/pulls/\(selected)/retry-merge", body: ["revision": .number(Double(item.revision ?? 0))]) } } } }
                        ForEach(detail.checks ?? []) { check in Text("Check \(check.commit?.prefix(7) ?? "") · \(check.status)" + (comparison != nil && comparison?.headCommit != check.commit ? " · previous commit" : "")).font(.caption).foregroundStyle(.secondary) }
                        if let comparison { DisclosureGroup("Changed files") { ScrollView(.horizontal) { Text(comparison.patch.isEmpty ? "No changes" : comparison.patch).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.padding(.top, 10) } }
                        ForEach(detail.comments ?? []) { comment in VStack(alignment: .leading, spacing: 8) { Divider(); Text(comment.author).font(.caption).foregroundStyle(.secondary); Markdown(comment.body).textSelection(.enabled) } }
                        TextField("Add a comment", text: $comment, axis: .vertical).lineLimit(3...8).textFieldStyle(.roundedBorder)
                        Button("Comment") { perform { let _: ProjectComment = try await request("/\(section)/\(selected)/comments", body: ["body": .string(comment)]); comment = "" } }.disabled(busy || comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                } else { ProgressView() }
            }.padding(24).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
    @ViewBuilder private func recordActions(_ item: ProjectWorkItem) -> some View {
        HStack {
            if item.status != "merged" {
                Button("Edit") { title = item.title ?? ""; bodyText = item.body ?? ""; editing = true; creating = true }
                Button(item.status == "open" ? "Close" : "Reopen") { perform { let _: ProjectWorkItem = try await request("/\(section)/\(selected)/\(item.status == "open" ? "close" : "reopen")", body: ["revision": .number(Double(item.revision ?? 0))]) } }
            }
            if section == "issues" { Button("Start task") { perform { let result: IssueTaskResponse = try await request("/issues/\(selected)/task", body: ["revision": .number(Double(item.revision ?? 0))]); openLinkedTask(result.task.id) } } }
            if section == "pulls", item.status == "open", let comparison {
                Button("Run checks") { perform { let _: ProjectWorkItem = try await request("/pipelines", body: ["pullId": .string(selected)]) } }
                Button("Merge") { perform { let _: ProjectWorkItem = try await request("/pulls/\(selected)/merge", body: ["revision": .number(Double(item.revision ?? 0)), "baseCommit": .string(comparison.baseCommit), "headCommit": .string(comparison.headCommit)]) } }.buttonStyle(.borderedProminent).disabled(!comparison.fastForward)
            }
        }.disabled(busy)
    }
    private func openLinkedTask(_ id: String) {
        if !isPhone { dismiss() }
        openTask(id)
    }
    private func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        Task { do { try await work(); await refresh() } catch { self.error = error.localizedDescription }; busy = false }
    }
    private func request<T: Decodable & Sendable>(_ path: String, body: [String: JSONValue]? = nil) async throws -> T {
        let client = WorkspaceClient(connection: connection)
        var payload = body
        var key: String?
        if let body {
            let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
            let signature = path + String(data: try encoder.encode(body), encoding: .utf8)!
            key = signature
            let operation = pendingCommands[signature] ?? UUID().uuidString
            pendingCommands[signature] = operation
            payload?["operationId"] = .string(operation)
        }
        let result: T = try await client.request(base + path, method: payload == nil ? "GET" : "POST", body: try payload.map { try JSONEncoder().encode($0) })
        if let key { pendingCommands.removeValue(forKey: key) }
        return result
    }
    private func refresh() async {
        let expectedSection = section, expectedSelection = selected
        do {
            let info: RepositoryInfo = try await request("/repository"); repository = info
            if expectedSection == "repository" { return }
            let response: ProjectWorkResponse = try await request("/\(expectedSection)")
            guard section == expectedSection else { return }
            items = response.items ?? response.runs ?? []
            if !expectedSelection.isEmpty {
                let next: ProjectWorkResponse = try await request("/\(expectedSection)/\(expectedSelection)")
                guard section == expectedSection, selected == expectedSelection else { return }
                detail = next
                if expectedSection == "pulls" { let diff: PullComparison = try await request("/pulls/\(expectedSelection)/diff"); if selected == expectedSelection { comparison = diff } }
            }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
