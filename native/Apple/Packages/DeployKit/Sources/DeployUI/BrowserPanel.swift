import SwiftUI
import DeployCore

struct BrowserPanel: View {
    @Environment(\.colorScheme) private var colorScheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    let store: WorkspaceStore
    var onReveal: (() -> Void)? = nil
    var onClose: (() -> Void)? = nil
    var onAspectRatioChange: ((CGFloat) -> Void)? = nil
    var onExpansionChange: ((Bool) -> Void)? = nil
    var onDragChanged: ((CGSize) -> Void)? = nil
    var onDragEnded: ((CGSize) -> Void)? = nil
    @State private var clientId = UUID().uuidString
    @State private var state: ControlState?
    @State private var sessionId = ""
    @State private var snapshot: ControlSnapshot?
    @State private var snapshotKey = ""
    @State private var revealKey = ""
    @State private var connectionError: String?
    @State private var error: String?
    @State private var busy = false
    @State private var restart: (id: String, reason: String)?
    @State private var restartInspected = false
    @State private var expanded = false
    @State private var hovering = false
    @FocusState private var viewerFocused: Bool
    private var session: ControlSession? { state?.sessions.first(where: { $0.id == sessionId }) ?? state?.sessions.last }
    private var own: Bool { session?.controlOwner == "user:" + clientId }
    private var ended: Bool { session?.isEnded == true }
    private var dimmed: Bool { ended || restart != nil }
    private var targetAvailable: Bool {
        store.isConnected && state?.targets.contains { $0.workerId == session?.workerId && $0.targetId == session?.targetId && $0.available } == true
    }
    private var canInput: Bool {
        store.isConnected && session?.viewOnly != true && own && session?.status == "active" && !busy && !(state?.commands.contains { $0.sessionId == session?.id && ["queued", "running"].contains($0.status) } ?? false)
    }
    private var active: Bool { session?.status == "active" }
    private var status: String {
        active ? own ? "You have control" : session?.controlOwner == "agent" ? "Agent has control" : "Another client has control" : ended ? "Ended" : session?.status.capitalized ?? "No session"
    }
    var body: some View {
        viewer
            .onChange(of: snapshotKey) { _, _ in
                if let width = snapshot?.width, let height = snapshot?.height, height > 0 { onAspectRatioChange?(width / height) }
            }
            #if os(macOS)
            .onChange(of: expanded) { _, value in onExpansionChange?(value) }
            #else
            .sheet(isPresented: $expanded) {
                NavigationStack {
                    viewer.frame(minWidth: expandedWidth, minHeight: 440)
                        .navigationTitle("Computer control").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { expanded = false } } }
                }.presentationDetents([.large])
            }
            #endif
            .task(id: store.selectedTaskId) {
                state = nil; snapshot = nil; snapshotKey = ""; sessionId = ""; revealKey = ""; restart = nil; busy = false; error = nil; connectionError = nil
                while !Task.isCancelled {
                    await refresh()
                    try? await Task.sleep(for: .seconds(1))
                }
            }
    }
    private var minimalViewer: some View {
        ZStack {
            if let snapshot, let encoded = snapshot.image, let data = Data(base64Encoded: encoded), let image = previewImage(data) {
                image.resizable().aspectRatio(contentMode: .fit)
                    .grayscale(dimmed ? 1 : 0)
                    .opacity(dimmed ? WorkspaceStyle.endedFrameOpacity : 1)
                    .overlay { GeometryReader { geometry in
                        Color.clear.contentShape(Rectangle()).gesture(SpatialTapGesture().onEnded { event in
                            guard canInput else { return }
                            let bounds = snapshot.inputBounds ?? ["x": 0, "y": 0, "width": snapshot.width ?? 1280, "height": snapshot.height ?? 800]
                            input(["type": .string("click"), "x": .number((bounds["x"] ?? 0) + event.location.x / geometry.size.width * (bounds["width"] ?? 1280)), "y": .number((bounds["y"] ?? 0) + event.location.y / geometry.size.height * (bounds["height"] ?? 800))])
                        })
                    } }.allowsHitTesting(!dimmed)
                    .accessibilityLabel(dimmed ? "Last frame from the ended session" : "Controlled window preview")
            }
            if dimmed { endedOverlay }
            VStack {
                HStack(spacing: 6) {
                    if let onClose { Button(action: onClose) { Image(systemName: "xmark") }.accessibilityLabel("Hide computer use") }
                    Image(systemName: "arrow.up.and.down.and.arrow.left.and.right")
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 2, coordinateSpace: .global).onChanged { onDragChanged?($0.translation) }.onEnded { onDragEnded?($0.translation) })
                        .accessibilityLabel("Move computer view")
                    #if os(iOS)
                    if !expanded {
                        Button { expanded = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                            .accessibilityLabel("Expand controlled view")
                    }
                    #else
                    Button { expanded.toggle() } label: { Image(systemName: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") }
                        .accessibilityLabel(expanded ? "Collapse controlled view" : "Expand controlled view")
                    #endif
                }.buttonStyle(.plain).padding(8).background(.regularMaterial, in: Capsule())
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .opacity(hovering || viewerFocused ? 1 : 0)
                Spacer()
                if session != nil {
                    HStack(spacing: 6) {
                        #if os(iOS)
                        if horizontalSizeClass == .compact {
                            PhoneStatusDot(status: active ? "running" : "inactive", size: 5)
                        } else { sessionStatusDot }
                        #else
                        sessionStatusDot
                        #endif
                        Text(status).font(.system(.caption))
                        if active && !dimmed {
                            Button(own ? "Return to agent" : "Take control") { perform(own ? "release" : "takeover") }.buttonStyle(.workspaceLink).disabled(busy)
                        }
                        if !dimmed {
                            Button("Stop") { perform("stop") }.buttonStyle(.workspaceLink).disabled(busy).accessibilityLabel("Stop control session")
                        }
                    }.buttonStyle(.plain).padding(8).background(.regularMaterial, in: Capsule())
                }
            }.padding(8)
        }
        .gesture(DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .onChanged { if !own && !dimmed { onDragChanged?($0.translation) } }
            .onEnded { if !own && !dimmed { onDragEnded?($0.translation) } })
        .onHover { hovering = $0 }
        .focusable().focused($viewerFocused).focusEffectDisabled()

    }
    private var endedOverlay: some View {
        VStack(spacing: WorkspaceStyle.space3) {
            Text(restart?.reason ?? session?.endedReason ?? "This session ended")
                .font(WorkspaceStyle.navigation)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(restart?.reason ?? session?.endedReason ?? "This session ended")
                .accessibilityAddTraits(.updatesFrequently)
            Button(action: startAgain) {
                HStack {
                    if busy { ProgressView().controlSize(.small) }
                    Text(busy ? "Starting…" : "Start again")
                }
            }.buttonStyle(.workspacePrimary).disabled(busy || !store.isConnected || !targetAvailable)
            if !targetAvailable {
                Text("\(session?.targetLabel ?? "This target") isn't available right now")
                    .font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
            }
            if let error = error ?? connectionError {
                Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(colorScheme))
            }
        }.padding(WorkspaceStyle.space4).multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WorkspaceStyle.canvas(colorScheme).opacity(1 - WorkspaceStyle.endedFrameOpacity))
    }
    private var sessionStatusDot: some View {
        Circle().fill(active ? WorkspaceStyle.statusActive(colorScheme) : WorkspaceStyle.statusInactive(colorScheme)).frame(width: 5, height: 5)
    }
    private var expandedWidth: CGFloat {
        #if os(macOS)
        760
        #else
        0
        #endif
    }
    private var pendingRequest: ControlRequest? { state?.requests?.first { $0.status == "pending" } }
    private var viewer: some View {
        VStack(spacing: 16) {
            if let request = pendingRequest {
                Image(systemName: "macwindow").font(.system(.title2, weight: .light))
                Text("Allow agent control?").font(.headline)
                Text(request.targetLabel).font(.body).lineLimit(2)
                Text("On \(workerName(request.workerId)) · up to 30 minutes")
                    .font(.caption).foregroundStyle(.secondary)
                Text("Share this \(request.kind == "browser" ? "browser" : "window") and allow clicks, typing, and scrolling. You can stop at any time.")
                    .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                HStack {
                    Button("Not now") { perform("deny", extra: ["requestId": .string(request.id)]) }.buttonStyle(.workspaceLink)
                    Button("Allow") { perform("approve", extra: ["requestId": .string(request.id)]) }.buttonStyle(.workspacePrimary)
                }.disabled(busy)
            } else if snapshot?.image != nil || dimmed {
                minimalViewer
            } else {
                Image(systemName: "macwindow").font(.system(.title2, weight: .light)).foregroundStyle(.secondary)
                Text(session == nil ? "Ask the agent to use a window" : status).font(.callout)
                Text(session?.reason ?? "The agent finds and opens the window through tools. Its view appears here.")
                    .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                if session != nil && !ended {
                    Button("Stop") { perform("stop") }.buttonStyle(.workspaceLink).disabled(busy)
                }
            }
            if !dimmed, let error = error ?? connectionError { Text(error).font(.caption).foregroundStyle(WorkspaceStyle.danger(colorScheme)) }
        }.padding(snapshot?.image != nil && pendingRequest == nil ? 0 : 20)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .topTrailing) {
                if snapshot?.image == nil || pendingRequest != nil, let onClose {
                    Button(action: onClose) { Image(systemName: "xmark").padding(10) }
                        .buttonStyle(.plain).accessibilityLabel("Hide computer use")
                }
            }
    }
    private func workerName(_ id: String) -> String { store.state?.workers.first { $0.id == id }?.name ?? id }
    @MainActor private func refresh() async {
        guard store.isConnected, let taskId = store.selectedTaskId else { return }
        do {
            let next = try await store.controlState(taskId: taskId)
            guard !Task.isCancelled, taskId == store.selectedTaskId else { return }
            state = next; connectionError = nil
            let chosen = next.sessions.last
            if chosen?.id != sessionId {
                if restart == nil { snapshot = nil }
                sessionId = chosen?.id ?? ""
            }
            if let chosen, restart?.id == chosen.id {
                if chosen.isEnded {
                    error = chosen.endedReason; restart = nil; busy = false
                } else if chosen.status == "active" && !restartInspected {
                    restartInspected = true
                    do {
                        _ = try await store.controlCommand(taskId: taskId, action: "input", body: [
                            "clientId": .string(clientId), "operationId": .string(UUID().uuidString),
                            "sessionId": .string(chosen.id), "generation": .string(chosen.generation),
                            "action": .object(["type": .string("inspect")])
                        ])
                    } catch {
                        guard !Task.isCancelled, taskId == store.selectedTaskId else { return }
                        self.error = error.localizedDescription; busy = false
                    }
                }
            }
            guard !Task.isCancelled, taskId == store.selectedTaskId else { return }
            let incoming = next.requests?.last(where: { $0.status == "pending" })?.id ?? (chosen.map { ["stopped", "suspended"].contains($0.status) ? "" : $0.id } ?? "")
            if incoming != revealKey { revealKey = incoming; if !incoming.isEmpty { onReveal?() } }
            let complete = next.commands.last { $0.sessionId == chosen?.id && $0.status == "succeeded" }
            let key = "\(chosen?.id ?? ""):\(complete?.id ?? "")"
            if let chosen, key != snapshotKey {
                let nextImage = try await store.controlSnapshot(taskId: taskId, sessionId: chosen.id)
                guard !Task.isCancelled, taskId == store.selectedTaskId, chosen.id == sessionId else { return }
                if nextImage?.image != nil || restart == nil { snapshot = nextImage; snapshotKey = key }
                if nextImage?.image == nil, complete != nil, restart?.id == chosen.id {
                    error = "The session opened, but no frame was captured"; busy = false
                }
                if nextImage?.image != nil, complete != nil, restart?.id == chosen.id {
                    restart = nil; busy = false; error = nil
                }
            }
        } catch { if !Task.isCancelled, taskId == store.selectedTaskId { self.connectionError = error.localizedDescription; if restart != nil { busy = false } } }
    }
    private func startAgain() {
        guard !busy, targetAvailable, store.isConnected, let session, let taskId = store.selectedTaskId else { return }
        if let restart, !restart.id.isEmpty {
            restartInspected = false; busy = true; error = nil
            return
        }
        guard ended else { return }
        busy = true; error = nil; restartInspected = false
        restart = (id: "", reason: session.endedReason)
        Task { @MainActor in
            do {
                let result = try await store.controlCommand(taskId: taskId, action: "open", body: [
                    "clientId": .string(clientId), "operationId": .string(UUID().uuidString),
                    "workerId": .string(session.workerId), "targetId": .string(session.targetId)
                ])
                guard taskId == store.selectedTaskId else { return }
                guard case let .object(value) = result, case let .string(id) = value["id"] else {
                    throw NSError(domain: "ControlSession", code: 0, userInfo: [NSLocalizedDescriptionKey: "The session could not be opened"])
                }
                restart = (id: id, reason: session.endedReason)
                await refresh()
            } catch {
                guard taskId == store.selectedTaskId else { return }
                self.error = error.localizedDescription; restart = nil; busy = false
            }
        }
    }
    private func input(_ action: [String: JSONValue]) { perform("input", extra: ["action": .object(action)]) }
    private func perform(_ action: String, extra: [String: JSONValue] = [:]) {
        guard store.isConnected, let taskId = store.selectedTaskId else { return }
        var body: [String: JSONValue] = ["clientId": .string(clientId), "operationId": .string(UUID().uuidString)]
        if let session { body["sessionId"] = .string(session.id); body["generation"] = .string(session.generation) }
        body.merge(extra) { _, new in new }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                let result = try await store.controlCommand(taskId: taskId, action: action, body: body)
                guard taskId == store.selectedTaskId else { return }
                if action == "approve", case let .object(value) = result, case let .string(id) = value["id"] {
                    sessionId = id
                    snapshot = nil
                }
                await refresh()
            }
            catch { self.error = error.localizedDescription }
        }
    }
    private func previewImage(_ data: Data) -> Image? {
        #if os(macOS)
        NSImage(data: data).map { Image(nsImage: $0) }
        #else
        UIImage(data: data).map { Image(uiImage: $0) }
        #endif
    }
}
