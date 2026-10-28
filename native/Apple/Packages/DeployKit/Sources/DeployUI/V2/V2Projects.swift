#if os(iOS)
import SwiftUI
import DeployCore

struct V2ProjectSection: View {
    @Bindable var store: V2Store
    let project: V2Project
    @State private var pulls: [ProjectWorkItem] = []
    @State private var issues: [ProjectWorkItem] = []
    @State private var releases: [Release] = []
    @State private var error: String?
    @State private var evidence = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            V2Group(title: project.name) {
                if !pulls.isEmpty { NavigationLink { V2ProjectWorkList(store: store, project: project, kind: "Pull requests", items: pulls) } label: { V2Row(title: "Pull requests", subtitle: pulls.first?.displayTitle, icon: "arrow.triangle.pull", trailing: "\(pulls.count)") } }
                if !issues.isEmpty { NavigationLink { V2ProjectWorkList(store: store, project: project, kind: "Issues", items: issues) } label: { V2Row(title: "Issues", subtitle: issues.first?.displayTitle, icon: "circle.dotted", trailing: "\(issues.count)") } }
                ForEach(store.snapshot.live?.computers.flatMap(\.apps).filter { $0.project == project.id } ?? []) { app in
                    NavigationLink { V2WorkerView(store: store, appId: app.id) } label: { V2Row(title: project.apps?.count == 1 ? "App" : app.name, subtitle: [app.release, app.name].compactMap { $0 }.joined(separator: " · "), state: app.state) }
                }
                if project.apps?.isEmpty == false { V2Row(title: "Logs", subtitle: "Live · view on a computer", icon: "text.alignleft") }
                if !releases.isEmpty { NavigationLink { V2ReleasesView(store: store, project: project) } label: { V2Row(title: "Releases", subtitle: releases.first?.source.ref, icon: "shippingbox", trailing: "\(releases.count)") } }
            }
            let tasks = store.tasks.filter { $0.projectId == project.id }
            if !tasks.isEmpty { V2Group(title: "Tasks") { ForEach(tasks) { task in Button { store.selectedTaskId = task.id } label: { V2Row(title: task.title, subtitle: task.status.capitalized, icon: "bubble.left") } } } }
            if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
        }.task(id: project.id) {
            await load()
            if ["ReleasesPhone", "ReleasePhone", "ReleaseFailedPhone"].contains(V2Evidence.board) { evidence = true }
        }.onChange(of: store.snapshot.cursor) { _, _ in Task { await load() } }
            .navigationDestination(isPresented: $evidence) { V2ReleasesView(store: store, project: project) }
    }
    private func load() async {
        do { releases = try await store.client.releases(project: project.id); error = nil }
        catch { self.error = coordinatorErrorDescription(error) }
        do { pulls = try await store.client.projectWork(project.id, kind: "pulls"); issues = try await store.client.projectWork(project.id, kind: "issues") }
        catch { if !(project.id.hasPrefix("app:")) { self.error = coordinatorErrorDescription(error) } }
    }
}
struct V2ProjectWorkList: View {
    @Bindable var store: V2Store
    let project: V2Project
    let kind: String
    let items: [ProjectWorkItem]
    var body: some View {
        List(items) { item in
            VStack(alignment: .leading, spacing: 8) {
                Text(item.displayTitle).font(.system(size: 17))
                Text([item.number.map { "#\($0)" }, item.status.capitalized].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 13)).foregroundStyle(.secondary)
                if let task = item.taskIds?.first { Button("Open task") { store.selectedTaskId = task } }
                else { Text("Open this \(kind == "Issues" ? "issue" : "pull request") on a computer to review.").font(.system(size: 13)).foregroundStyle(.secondary) }
            }
        }.navigationTitle(kind).navigationBarTitleDisplayMode(.inline)
    }
}
#endif
