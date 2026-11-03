#if os(iOS)
import SwiftUI
import DeployCore

struct V2ReleaseSteps: View {
    let steps: [ReleaseStep]
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(steps, id: \.name) { step in
                HStack(alignment: .top, spacing: 10) {
                    if step.state == .running { ProgressView().controlSize(.small) }
                    else { Image(systemName: step.state == .done ? "checkmark" : step.state == .failed ? "xmark.circle" : "circle").frame(width: 18).foregroundStyle(step.state == .failed ? WorkspaceStyle.danger(scheme) : step.state == .done ? WorkspaceStyle.success(scheme) : WorkspaceStyle.tertiary(scheme)) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(step.name.rawValue.capitalized + (step.state == .skipped ? " · skipped" : "")).font(.system(size: 17))
                        if let detail = step.detail { Text(detail).font(.system(size: 13)).foregroundStyle(.secondary).textSelection(.enabled) }
                    }
                }
            }
        }.padding(12)
    }
}
struct V2ReleasesView: View {
    @Bindable var store: V2Store
    let project: V2Project
    @State private var releases: [Release] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var selected: String?
    @State private var confirm = false
    @State private var busy = false
    @State private var rollback: Rollback?
    private var current: Release? { releases.first { $0.state == .live || $0.state == .running } }
    private var prior: Release? { releases.first { $0.state == .superseded || $0.state == .rolledBack } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let current {
                    V2Group(title: current.state == .running ? "Releasing" : "Live now") { releaseRow(current) }
                    V2ReleaseContents(store: store, release: current)
                }
                if let rollback { V2RollbackProgress(store: store, initial: rollback) }
                let earlier = releases.filter { $0.id != current?.id }
                if !earlier.isEmpty { V2Group(title: "Earlier") { ForEach(earlier, id: \.id) { releaseRow($0) } } }
                if !loaded && error == nil { V2Group { V2Row(title: "Loading releases", subtitle: "Release contents", icon: "shippingbox").redacted(reason: .placeholder) } }
                if loaded && releases.isEmpty && error == nil { V2Empty(title: "No releases yet", message: "Ship from a task whenever you are ready.") }
                if let current, let prior, current.state == .live {
                    Button("Roll back to \(prior.id.prefix(7))…") { confirm = true }.buttonStyle(V2ActionStyle()).disabled(!store.online || busy)
                }
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
            }.padding(16)
        }.navigationTitle("\(project.name) releases").navigationBarTitleDisplayMode(.inline)
            .task { await load(); if ["ReleasePhone", "ReleaseFailedPhone"].contains(V2Evidence.board) { selected = releases.first?.id } }
            .onChange(of: store.snapshot.cursor) { _, _ in Task { await load() } }
            .refreshable { await load() }
            .navigationDestination(isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) { if let selected { V2ReleaseDetail(store: store, releaseId: selected) } }
            .confirmationDialog("Roll back every app in \(project.name) to \(prior?.id.prefix(7) ?? "")?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Roll back") { Task { await rollBack() } }
                Button("Cancel", role: .cancel) {}
            }
    }
    private func releaseRow(_ release: Release) -> some View {
        Button { selected = release.id } label: { V2Row(title: String(release.id.prefix(7)), subtitle: release.source.ref, icon: "shippingbox", trailing: release.state.rawValue.replacingOccurrences(of: "-", with: " ").capitalized) }
    }
    private func load() async {
        guard store.online else { return }
        do { releases = try await store.client.releases(project: project.id); loaded = true; rollback = try await store.client.rollbacks(project: project.id).first; error = nil }
        catch { self.error = coordinatorErrorDescription(error) }
    }
    private func rollBack() async {
        guard let current, let prior, !busy else { return }
        busy = true; defer { busy = false }
        do { rollback = try await store.client.rollback(project: project.id, from: current.id, to: prior.id); await load() }
        catch { self.error = coordinatorErrorDescription(error) + " Review Releases before trying again. Data-loss confirmation is available on a computer." }
    }
}
struct V2ReleaseContents: View {
    @Bindable var store: V2Store
    let release: Release
    var body: some View {
        V2Group(title: "In this release") {
            ForEach(release.apps, id: \.appId) { app in
                let health = store.snapshot.live?.computers.flatMap(\.apps).first { $0.id == app.appId }
                V2Row(title: health?.name ?? app.appId, subtitle: [app.from.map { String($0.prefix(7)) }, String(app.to.prefix(7))].compactMap { $0 }.joined(separator: " → "), state: health?.state)
            }
            ForEach(release.migrations, id: \.id) { migration in V2Row(title: migration.title, subtitle: migration.reversible ? "Reversible migration" : "Requires a pre-release backup", icon: "externaldrive") }
            if release.apps.isEmpty { V2Row(title: "Preparing release contents", icon: "clock") }
        }
    }
}
struct V2ReleaseDetail: View {
    @Bindable var store: V2Store
    let releaseId: String
    @State private var initial: Release?
    @State private var error: String?
    @State private var ask = false
    private var release: Release? { store.releases[releaseId] ?? initial }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let release {
                    V2Group {
                        V2Row(title: status(release), subtitle: "\(release.source.ref) · \(release.startedBy)", icon: release.state == .failed ? "xmark.circle" : "shippingbox")
                    }
                    if release.state == .failed, release.steps.first(where: { $0.name == .activate })?.state == .skipped {
                        Text("Nothing changed. The previous release is still serving.").font(.system(size: 15))
                    }
                    V2ReleaseSteps(steps: release.steps)
                    V2ReleaseContents(store: store, release: release)
                    if release.state == .failed {
                        Text("Variables are changed on a computer, in the project's settings.").font(.system(size: 13)).foregroundStyle(.secondary)
                        Button("Ask for a fix") {
                            var draft = store.composer(taskId: nil)
                            draft.agent = ""; draft.question = false; draft.projectId = release.projectId
                            draft.text = "Help me fix release \(release.id) for \(release.projectId). " + (release.steps.first { $0.state == .failed }?.detail ?? "The release failed.")
                            store.saveComposer(draft, context: "new"); ask = true
                        }.buttonStyle(V2ActionStyle(primary: true))
                    }
                }
                if release == nil && error == nil { V2Group { V2Row(title: "Loading release", subtitle: "Release progress", icon: "shippingbox").redacted(reason: .placeholder) } }
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
            }.padding(16)
        }.navigationTitle("Release \(releaseId.prefix(7))").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
            .sheet(isPresented: $ask) { V2ComposerSheet(store: store) }
    }
    private func status(_ release: Release) -> String {
        if release.state == .running { return (release.steps.first { $0.state == .running }?.name.rawValue.capitalized ?? "Preparing") + " · " + String(release.id.prefix(7)) }
        return release.state.rawValue.replacingOccurrences(of: "-", with: " ").capitalized
    }
    private func load() async {
        do { initial = try await store.client.release(releaseId); error = nil }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}
struct V2RollbackProgress: View {
    @Bindable var store: V2Store
    let initial: Rollback
    private var rollback: Rollback { store.rollbacks[initial.id] ?? initial }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            let failed = rollback.steps.contains { $0.state == .failed }
            let done = !rollback.steps.isEmpty && rollback.steps.allSatisfy { $0.state == .done }
            Text(failed ? "Rollback failed" : done ? "Rolled back" : "Rolling back").font(.system(size: 17, weight: .medium))
            Text("\(rollback.from.prefix(7)) → \(rollback.to.prefix(7)) · approved by \(rollback.approvedBy)").font(.system(size: 13)).foregroundStyle(.secondary)
            V2ReleaseSteps(steps: rollback.steps)
            Text("You can close the app. Progress is saved on your coordinator.").font(.system(size: 13)).foregroundStyle(.secondary)
        }
    }
}
struct V2ProjectRollback: View {
    @Bindable var store: V2Store
    let project: String
    @State private var initial: Rollback?
    @State private var error: String?
    var body: some View {
        Group {
            if let initial { V2RollbackProgress(store: store, initial: initial) }
            if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
        }.task(id: store.snapshot.cursor) {
            do { initial = try await store.client.rollbacks(project: project).first; error = nil }
            catch { self.error = coordinatorErrorDescription(error) }
        }
    }
}
struct V2ShipSheet: View {
    @Bindable var store: V2Store
    let project: V2Project
    let taskId: String
    @State private var ref = ""
    @State private var busy = false
    @State private var submitted = false
    @State private var release: Release?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("The whole project moves together. Health is monitored after the release activates.").font(.system(size: 15)).foregroundStyle(.secondary)
                    V2Group {
                        ForEach(project.apps ?? []) { app in V2Row(title: app.name, subtitle: app.kind == .worker ? "Worker" : "Web app") }
                        V2Row(title: "Runs on", subtitle: "Uses the project's configured computers", icon: "desktopcomputer")
                        V2Row(title: "Address, access and data", subtitle: "Uses the project's settings. Change these on a computer.", icon: "network")
                    }
                    TextField("Branch or commit", text: $ref).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Prepare the release", systemImage: "shippingbox")
                        Label("Verify it on a copy, then switch", systemImage: "checkmark.shield")
                        Label("Monitor health for 10 minutes", systemImage: "waveform.path.ecg")
                    }.font(.system(size: 13)).foregroundStyle(.secondary)
                    if project.apps?.isEmpty != false { Text("This project has no configured apps to release. Set up its app on a computer first.").font(.system(size: 13)) }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
                    Button(busy ? "Starting release…" : "Ship") { Task { await ship() } }.buttonStyle(V2ActionStyle(primary: true)).disabled(!store.online || busy || submitted || ref.isEmpty || project.apps?.isEmpty != false)
                }.padding(16)
            }.navigationTitle("Ship \(project.name)").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }
                .task { do { ref = try await store.client.repository(project.id).defaultBranch ?? "" } catch { self.error = "Choose the branch or commit to release." } }
                .navigationDestination(isPresented: Binding(get: { release != nil }, set: { if !$0 { release = nil } })) { if let release { V2ReleaseDetail(store: store, releaseId: release.id) } }
        }.presentationDragIndicator(.visible)
    }
    private func ship() async {
        guard !busy, !submitted else { return }
        busy = true; submitted = true; defer { busy = false }
        do { release = try await store.client.ship(project: project.id, task: taskId, ref: ref) }
        catch { self.error = coordinatorErrorDescription(error) + " Check the project's Releases before starting another release." }
    }
}
#endif
