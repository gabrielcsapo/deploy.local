#if os(iOS)
import SwiftUI
import DeployCore

struct V2ProjectSection: View {
    @Bindable var store: V2Store
    let project: V2Project
    var status: ([V2LoadState]) -> Void = { _ in }
    @State private var pullsRead = V2Read<[ProjectWorkItem]>()
    private var pulls: [ProjectWorkItem] { pullsRead.value ?? [] }
    @State private var issuesRead = V2Read<[ProjectWorkItem]>()
    private var issues: [ProjectWorkItem] { issuesRead.value ?? [] }
    @State private var releasesRead = V2Read<[Release]>()
    private var releases: [Release] { releasesRead.value ?? [] }
    @State private var designRead = V2Read<V2DesignSummary?>()
    private var design: V2DesignSummary? { designRead.value ?? nil }
    @State private var openDesign = false
    @Environment(\.horizontalSizeClass) private var width
    @State private var error: String?
    @State private var evidence = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            V2Group(title: project.name) {
                V2LoadRegion(state: pullsRead.state, copy: .resource("Project details"), lastHeard: store.readDates["project:pulls:" + project.id], icons: false, retry: { await loadPart("pulls") }) {
                    if !pulls.isEmpty { NavigationLink { V2ProjectWorkList(store: store, project: project, kind: "Pull requests", items: pulls) } label: { V2Row(title: "Pull requests", subtitle: pulls.first?.displayTitle, icon: "arrow.triangle.pull", trailing: "\(pulls.count)") } }
                }
                V2LoadRegion(state: issuesRead.state, copy: .resource("Project details"), lastHeard: store.readDates["project:issues:" + project.id], icons: false, retry: { await loadPart("issues") }) {
                    if !issues.isEmpty { NavigationLink { V2ProjectWorkList(store: store, project: project, kind: "Issues", items: issues) } label: { V2Row(title: "Issues", subtitle: issues.first?.displayTitle, icon: "circle.dotted", trailing: "\(issues.count)") } }
                }
                V2LoadRegion(state: designRead.state, copy: .resource("Project details"), lastHeard: store.readDates["project:design:" + project.id], icons: false, retry: { await loadPart("design") }) {
                    if let design { Button { openDesign = true } label: { V2Row(title: "Design", subtitle: design.subtitle, icon: "square.3.layers.3d") } }
                }
                V2LoadRegion(state: store.loadState("live"), copy: .resource("Project details"), lastHeard: store.snapshot.resourceDates["live"], status: true, retry: { await store.refreshResources(["live"]) }) {
                    ForEach(store.snapshot.live?.computers.flatMap(\.apps).filter { V2AppPresentation.projectID(for: $0) == project.id } ?? []) { app in
                        NavigationLink(value: V2ProjectRoute.app(app.id)) { V2Row(title: project.apps?.count == 1 ? "App" : app.name, subtitle: [app.release.map { String($0.prefix(7)) }, app.name].compactMap { $0 }.joined(separator: " · "), state: app.state) }
                    }
                    if project.apps?.isEmpty == false { V2Row(title: "Logs", subtitle: "Live · view on a computer", icon: "text.alignleft") }
                }
                V2LoadRegion(state: releasesRead.state, copy: .resource("Project details"), lastHeard: store.readDates["project:releases:" + project.id], icons: false, retry: { await loadPart("releases") }) {
                    if !releases.isEmpty { NavigationLink { V2ReleasesView(store: store, project: project) } label: { V2Row(title: "Releases", subtitle: releases.first?.source.ref, icon: "shippingbox", trailing: "\(releases.count)") } }
                }
            }
            V2LoadRegion(state: store.loadState("workspace"), copy: .resource("Project details"), lastHeard: store.snapshot.resourceDates["workspace"], icons: false, retry: { await store.refreshResources(["workspace"]) }) {
                let tasks = store.tasks.filter { $0.projectId == project.id }
                if !tasks.isEmpty { V2Group(title: "Tasks") { ForEach(tasks) { task in Button { store.selectedTaskId = task.id } label: { V2Row(title: task.title, subtitle: task.status.capitalized, icon: "bubble.left") } } } }
            }
            if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
        }.task(id: project.id) {
            await load()
            if ["ReleasesPhone", "ReleasePhone", "ReleaseFailedPhone"].contains(V2Evidence.board) { evidence = true }
        }.onChange(of: store.snapshot.cursor) { _, _ in Task { await load(foreground: false) } }
            .onDisappear { pullsRead.leave(); issuesRead.leave(); releasesRead.leave(); designRead.leave(); status([]) }
            .refreshable { await load() }
            .onChange(of: [pullsRead.state, issuesRead.state, releasesRead.state, designRead.state, store.loadState("workspace"), store.loadState("live")], initial: true) { _, states in status(states) }
            .navigationDestination(isPresented: $evidence) { V2ReleasesView(store: store, project: project) }
            // On iPhone, Design opens inside Projects so the tab bar stays; on iPad it fills the
            // screen and the page's own rail holds the app's places.
            .navigationDestination(isPresented: Binding(get: { openDesign && width == .compact }, set: { if !$0 { openDesign = false } })) {
                V2DesignLanding(store: store, projectId: project.id)
            }
            .fullScreenCover(isPresented: Binding(get: { openDesign && width != .compact }, set: { if !$0 { openDesign = false } })) {
                V2DesignView(connection: store.connection, projectId: project.id)
            }
    }
    private func load(foreground: Bool = true) async {
        async let pulls: Void = loadPart("pulls", foreground: foreground)
        async let issues: Void = loadPart("issues", foreground: foreground)
        async let design: Void = loadPart("design", foreground: foreground)
        async let releases: Void = loadPart("releases", foreground: foreground)
        _ = await (pulls, issues, design, releases)
    }
    private func loadPart(_ part: String, foreground: Bool = true) async {
        let key = "project:" + part + ":" + project.id
        switch part {
        case "pulls": await pullsRead.load(store: store, key: key, foreground: foreground) { try await store.client.projectWork(project.id, kind: "pulls") }
        case "issues": await issuesRead.load(store: store, key: key, foreground: foreground) { try await store.client.projectWork(project.id, kind: "issues") }
        case "design": await designRead.load(store: store, key: key, foreground: foreground) { try await store.client.designSummary(project: project.id) }
        default: await releasesRead.load(store: store, key: key, foreground: foreground) { try await store.client.releases(project: project.id) }
        }
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
