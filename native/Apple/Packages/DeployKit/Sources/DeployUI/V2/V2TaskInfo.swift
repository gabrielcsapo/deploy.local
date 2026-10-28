#if os(iOS)
import SwiftUI
import DeployCore

struct V2TaskInfo: View {
    @Bindable var store: V2Store
    let taskId: String
    let detail: TaskDetail?
    let diff: TaskDiff?
    let selectTab: (String) -> Void
    @State private var releases: [Release] = []
    @State private var loaded = false
    @State private var repository: RepositoryInfo?
    @State private var error: String?
    @State private var ship = false
    @Environment(\.dismiss) private var dismiss
    private var task: V2Task? { store.tasks.first { $0.id == taskId } }
    private var project: V2Project? { store.snapshot.projects.first { $0.id == task?.projectId } }
    private var screenshots: [ScreenshotEvent] { store.conversation(taskId).compactMap { if case .screenshot(let screenshot) = $0 { screenshot } else { nil } } }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("Task · \(task.map { V2Labels.shortDate($0.createdAt) } ?? "Unavailable")").font(.system(size: 13)).foregroundStyle(.secondary)
                    if let project {
                        V2Group(title: "Project") {
                            V2Row(title: project.name, subtitle: project.apps?.map { $0.kind == .web ? "Web app" : "Worker" }.joined(separator: " · "), icon: "folder")
                            if let repository { V2Row(title: repository.clonePath, subtitle: repository.defaultBranch, icon: "arrow.triangle.branch") }
                        }
                    }
                    V2Group(title: "Running on") {
                        V2Row(title: store.snapshot.workspace?.workers.first { $0.id == task?.workerId }?.name ?? "Unavailable", subtitle: detail?.runs.last?.adapter.capitalized, icon: "desktopcomputer")
                    }
                    V2Group(title: "Work") {
                        Button { selectTab("Changes"); dismiss() } label: { V2Row(title: diff.map { "\($0.files.count) files changed" } ?? "Changes unavailable", subtitle: "Changes", icon: "doc") }
                        Button { selectTab("Checks"); dismiss() } label: { V2Row(title: diff.map { "\($0.checks.count) check results" } ?? "Checks unavailable", subtitle: "Review results", icon: "checkmark.circle") }
                    }
                    if !screenshots.isEmpty {
                        V2Group(title: "Screenshots") { V2Row(title: "\(screenshots.count) screenshots", subtitle: "Image delivery is not available from this coordinator. Open the task on a computer.", icon: "photo") }
                    }
                    V2Group(title: "Releases") {
                        if releases.isEmpty { V2Row(title: error != nil ? "Unavailable" : loaded ? "None yet" : "Loading releases…", subtitle: "Ship whenever you are ready", icon: "shippingbox") }
                        ForEach(releases, id: \.id) { release in NavigationLink { V2ReleaseDetail(store: store, releaseId: release.id) } label: { V2Row(title: String(release.id.prefix(7)), subtitle: release.state.rawValue.capitalized, icon: "shippingbox") } }
                    }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
                    Button("Ship…") { ship = true }.buttonStyle(V2ActionStyle()).disabled(project == nil || !store.online)
                }.padding(16)
            }.navigationTitle(task?.title ?? "Task info").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
                .task {
                    guard let project else { return }
                    do { releases = try await store.client.releases(project: project.id); loaded = true } catch { self.error = coordinatorErrorDescription(error) }
                    repository = try? await store.client.repository(project.id)
                }
                .sheet(isPresented: $ship) { if let project { V2ShipSheet(store: store, project: project, taskId: taskId) } }
        }.presentationDragIndicator(.visible)
    }
}
struct V2AgentMenu: View {
    let agent: String
    let taskURL: URL?
    let search: () -> Void
    let info: () -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Button("Search this conversation", systemImage: "magnifyingglass") { dismiss(); search() }
                Button("Agent info", systemImage: "info.circle") { dismiss(); info() }
                if let taskURL { Button("Copy link", systemImage: "link") { UIPasteboard.general.url = taskURL; dismiss() } }
                Section {
                    Label("Mute for 1 hour", systemImage: "bell.slash").foregroundStyle(.secondary)
                    Label("Tune \(agent.capitalized)", systemImage: "slider.horizontal.3").foregroundStyle(.secondary)
                    Label("Pause \(agent.capitalized)", systemImage: "pause").foregroundStyle(.secondary)
                } footer: { Text("Mute and Pause are not supported by this coordinator. Tune is available in agent settings on a computer.") }
            }.navigationTitle(agent.capitalized).navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { dismiss() } }
        }.presentationDetents([.medium, .large])
    }
}
#endif
