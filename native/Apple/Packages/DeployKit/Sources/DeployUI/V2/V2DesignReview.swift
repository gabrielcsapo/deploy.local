#if os(iOS)
import SwiftUI
import UIKit
import DeployCore

struct V2DesignReviewView: View {
    @Bindable var store: V2Store
    let item: InboxItem
    var completed: (String) -> Void = { _ in }
    @State private var model = V2ReviewState()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase
    @State private var active = false
    @ScaledMetric(relativeTo: .title) private var coverHeadingSize = 28
    @ScaledMetric(relativeTo: .largeTitle) private var headingSize = 30
    private var review: V2DesignReview? { model.review }
    private var screens: [V2DesignReview.Board] { review.map(V2ReviewModel.screens) ?? [] }
    private var pages: [V2ReviewModel.Page] { review.map(V2ReviewModel.pages) ?? [.cover] }
    private var board: V2DesignReview.Board? {
        guard case .screen(let file) = model.page else { return nil }
        return review?.boards.first { $0.file == file }
    }
    private var note: V2DesignReview.Note? {
        guard case .note(let id) = model.page else { return nil }
        return review?.changedNotes.first { $0.id == id }
    }
    private var canDecide: Bool { model.decisionsReady && store.online && !store.busy && review?.stale != true }
    private var seenKey: String {
        guard active, scenePhase == .active, !model.obscured else { return "" }
        if let board, model.preview(board) != nil { return "screen:\(board.file)" }
        if let note { return "note:\(note.id)" }
        return ""
    }

    var body: some View {
        VStack(spacing: 0) {
            if let review {
                if !pages.contains(model.page), let board {
                    // Unchanged round-two screens are inspectable from All screens, outside the swipe sequence.
                    screenPage(board)
                } else {
                    TabView(selection: $model.page) {
                        cover(review).tag(V2ReviewModel.Page.cover)
                        ForEach(screens) { board in screenPage(board).tag(V2ReviewModel.Page.screen(board.file)) }
                        ForEach(review.changedNotes) { note in
                            V2ReviewNotePage(model: model, note: note).tag(V2ReviewModel.Page.note(note.id))
                        }
                        decide(review).tag(V2ReviewModel.Page.decide)
                    }.tabViewStyle(.page(indexDisplayMode: .never))
                }
                if board != nil || note != nil { reviewToolbar }
            } else {
                VStack(alignment: .leading, spacing: 18) {
                    RoundedRectangle(cornerRadius: 8).fill(WorkspaceStyle.line(scheme)).frame(height: 68)
                    RoundedRectangle(cornerRadius: 8).fill(WorkspaceStyle.line(scheme)).frame(height: 120)
                    Text("Loading screens…").font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                }.padding(24)
            }
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(WorkspaceStyle.danger(scheme)).padding(12) }
        }
        .background(WorkspaceStyle.canvas(scheme))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { if model.page == .cover { dismiss() } else { model.page = .cover } } label: { Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("Back")
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    Text(board?.name ?? note?.title ?? (model.page == .decide ? "Finish review" : "Design review")).font(.headline).lineLimit(1).truncationMode(.tail)
                    if let board {
                        Text(screenCounter(board)).font(.footnote).foregroundStyle(.secondary)
                    } else if let note, let index = review?.changedNotes.firstIndex(where: { $0.id == note.id }) {
                        Text("Note \(index + 1) of \(review?.changedNotes.count ?? 0)").font(.footnote).foregroundStyle(.secondary)
                    }
                }.accessibilityElement(children: .combine)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if model.page == .cover { Button("See all screens") { model.grid = true } }
                    else {
                        Button("Approve design") { model.finishReview() }
                        Button("Ask for changes") { model.finishReview() }
                    }
                    Button("Open the Design page") { model.design = true }
                } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("More")
            }
        }
        .sheet(isPresented: $model.grid) { gridSheet.presentationDetents([.large]).presentationDragIndicator(.visible) }
        .sheet(isPresented: $model.pinSheet, onDismiss: { model.draft = nil; model.editing = nil }) {
            V2ReviewPinSheet(model: model, client: store.client).presentationDetents([.medium, .large]).presentationDragIndicator(.visible).interactiveDismissDisabled(model.saving)
        }
        .sheet(isPresented: $model.conflict) { conflictSheet.presentationDetents([.medium, .large]) }
        .fullScreenCover(isPresented: $model.design) { V2DesignView(connection: store.connection, projectId: model.project) }
        .alert("Ask for changes", isPresented: $model.asking) {
            TextField("What should change?", text: $model.note)
            Button("Send") { answer("changes", note: model.note) }.disabled(model.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !canDecide)
            Button("Cancel", role: .cancel) {}
        }
        .task(id: "\(item.id)@\(displayScale)") { await model.load(client: store.client, item: item, scale: displayScale) }
        .task(id: seenKey) {
            let key = seenKey
            guard !key.isEmpty else { return }
            do {
                try await Task.sleep(for: .seconds(1))
                try Task.checkCancellation()
                guard seenKey == key else { return }
                if let board { await model.markSeen(client: store.client, file: board.file) }
                else if let note { model.seenNotes.insert(note.id) }
            } catch { /* Losing visibility cancels the continuous foreground second. */ }
        }
        .onAppear { active = true }
        .onDisappear { active = false }
        .onChange(of: model.page) { _, _ in model.pinTool = false }
    }

    private func screenPage(_ board: V2DesignReview.Board) -> some View {
        V2ReviewScreenPage(model: model, board: board, client: store.client, active: model.page == .screen(board.file) && !model.obscured)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Screen \(screenCounter(board)), \(board.name), \(board.changeKind)")
    }
    private func screenCounter(_ board: V2DesignReview.Board) -> String {
        let sequence = screens.contains { $0.file == board.file } ? screens : review.map(V2ReviewModel.canvasBoards) ?? []
        return "\((sequence.firstIndex { $0.file == board.file } ?? 0) + 1) of \(sequence.count)"
    }
    private func cover(_ review: V2DesignReview) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text((review.round ?? 1) > 1 ? "Since your last review" : review.title ?? review.item.title)
                        .font(.system(size: coverHeadingSize, weight: .bold)).tracking(-0.6).lineLimit(2).truncationMode(.tail)
                    Text(review.summary ?? "No summary. Ask \(review.proposer?.name ?? V2Labels.agentName(review.item)) to add one")
                        .font(.body).foregroundStyle(WorkspaceStyle.secondary(scheme)).fixedSize(horizontal: false, vertical: true)
                    if (review.round ?? 1) > 1 { pinList(review, replies: true) }
                    else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(review.proposer?.name ?? V2Labels.agentName(review.item)) · \(V2ReviewModel.age(review.createdAt ?? review.item.createdAt))")
                            Text(review.counts?.label() ?? V2ReviewModel.count(review.boards.count, "screen"))
                            if let updated = review.updatedWithMainAt, review.stale != true { Text("Updated with main \(V2ReviewModel.age(updated)) · no conflicts") }
                        }.font(.footnote).foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            ForEach(screens.prefix(4)) { board in
                                Button { model.page = .screen(board.file) } label: { V2ReviewCrop(preview: model.preview(board), showChanges: board.changeKind == "changed") }
                                    .frame(height: 128).clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityLabel(board.name)
                            }
                        }
                    }
                }.padding(.horizontal, 24).padding(.top, 16)
            }
            VStack(spacing: 6) {
                if review.stale == true {
                    Button("\(V2ReviewModel.count(review.conflicts?.count ?? 0, "screen")) conflict with main") { model.conflict = true }.buttonStyle(V2ReviewActionStyle(primary: false))
                } else {
                    Button((review.round ?? 1) > 1 ? "Review \(V2ReviewModel.count(screens.count, "changed screen"))" : "Start review") {
                        model.page = pages.dropFirst().first ?? .decide
                    }.buttonStyle(V2ReviewActionStyle(primary: true))
                }
                Button((review.round ?? 1) > 1 ? "\(V2ReviewModel.count(review.boards.count - screens.count, "unchanged screen"))" : "See all screens") { model.grid = true }
                    .font(.body).foregroundStyle(.secondary).frame(minHeight: 44)
            }.padding(24)
        }
    }
    private func decide(_ review: V2DesignReview) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    Text("You’ve looked at\n\(review.boards.filter { $0.seen == true }.count) of \(review.boards.count)")
                        .font(.system(size: headingSize, weight: .bold)).tracking(-0.6)
                    pinList(review, replies: false)
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
            VStack(spacing: 6) {
                if model.loading || model.checking || !model.loadingKeys.isEmpty { Text("Loading \(V2ReviewModel.count(review.boards.count, "screen"))…").font(.footnote).foregroundStyle(.secondary) }
                if let answer = review.item.answer {
                    Text("\(V2Labels.outcome(review.item)) · \(answer.by)").font(.footnote)
                } else if review.stale == true {
                    Button("Ask to update") { model.conflict = true }.buttonStyle(V2ReviewActionStyle(primary: true))
                    Button("Close") { dismiss() }.frame(minHeight: 44)
                } else {
                    let primary = V2ReviewModel.primaryAction(review)
                    Button(primary.title) { if primary == .approve { answer("approve") } else { askForChanges() } }.buttonStyle(V2ReviewActionStyle(primary: true)).disabled(!canDecide)
                    Button(primary == .approve ? "Ask for changes" : "Approve design") { if primary == .approve { askForChanges() } else { answer("approve") } }.buttonStyle(V2ReviewActionStyle(primary: false)).disabled(!canDecide)
                }
            }.padding(24)
        }
    }
    private func pinList(_ review: V2DesignReview, replies: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your pins · \(model.pins.count)").font(.headline)
            ForEach(model.pins.sorted { $0.number < $1.number }) { pin in
                Button { model.edit(pin) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(pin.number)").font(.footnote).frame(width: 24, height: 24).overlay(Circle().stroke(WorkspaceStyle.line(scheme)))
                        VStack(alignment: .leading, spacing: 5) {
                            Text(pin.text).font(.body).fixedSize(horizontal: false, vertical: true)
                            Text(pin.noteId.flatMap { id in review.changedNotes.first { $0.id == id }?.title } ?? review.boards.first { $0.file == pin.board }?.name ?? pin.board).font(.footnote).foregroundStyle(.secondary)
                            if replies {
                                Label(pin.resolved ? "Addressed" : "Still open", systemImage: pin.resolved ? "checkmark" : "circle").font(.footnote)
                                if let reply = pin.reply { Text(reply).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(.vertical, replies ? 10 : 19)
                }.buttonStyle(.plain)
                if pin.id != model.pins.last?.id { Divider() }
            }
        }
    }
    private var reviewToolbar: some View {
        VStack(spacing: 10) {
            HStack(spacing: 16) {
                if board?.changeKind == "changed" || (note?.before != nil && note?.after != nil) {
                    tool("Show changes", "square.lefthalf.filled", selected: model.showChanges) { model.showChanges.toggle() }
                }
                tool("Pin", "pin", selected: model.pinTool) { model.pinTool.toggle() }.disabled(review?.item.state != .waiting || (board != nil && board.flatMap(model.preview) == nil))
                tool("All screens", "square.grid.2x2") { model.grid = true }
                Spacer(minLength: 0)
                let seen = board?.seen == true || note.map { model.seenNotes.contains($0.id) } == true
                let pins = model.pins.filter { pin in board.map { pin.board == $0.file && pin.noteId == nil } ?? (pin.noteId == note?.id) }.count
                HStack(spacing: 4) {
                    if seen { Image(systemName: "checkmark") }
                    Text("\(seen ? "Seen" : "Not seen") · \(V2ReviewModel.count(pins, "pin"))")
                }.font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ProgressView(value: Double(pages.firstIndex(of: model.page) ?? 0), total: Double(max(1, pages.count - 1)))
                .tint(WorkspaceStyle.text(scheme)).accessibilityLabel("Review position")
        }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
            .overlay(alignment: .top) { Divider() }
    }
    private func tool(_ label: String, _ icon: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.system(size: 22)).frame(width: 44, height: 44).background(selected ? WorkspaceStyle.line(scheme) : .clear, in: Circle()) }
            .buttonStyle(.plain).accessibilityLabel(label).accessibilityAddTraits(selected ? .isSelected : [])
    }
    private var gridSheet: some View {
        NavigationStack {
            ScrollView {
                if let review {
                    ForEach(Array(gridGroups(review).enumerated()), id: \.offset) { _, group in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text(group.title ?? "").font(.system(size: 17, weight: .semibold)); Spacer(); Text(V2ReviewModel.count(group.boards.count, "screen")).font(.footnote).foregroundStyle(.secondary) }.padding(.horizontal, 16)
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3, alignment: .top), count: 3), spacing: 3) {
                                ForEach(group.boards, id: \.self) { file in
                                    if let board = review.boards.first(where: { $0.file == file }) { gridTile(board) }
                                }
                            }.scrollTargetLayout().padding(.horizontal, 3)
                        }.padding(.bottom, 16)
                    }
                }
            }
            .scrollPosition(id: $model.gridAnchor)
            .navigationTitle("All screens").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { model.grid = false } label: { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("Close")
                }
            }
            .safeAreaInset(edge: .bottom) {
                HStack {
                    Text("\(review?.boards.filter { $0.seen == true }.count ?? 0) of \(review?.boards.count ?? 0) seen").font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    let next = review.flatMap { V2ReviewModel.nextUnseen($0, after: board?.file) }
                    Button(next == nil ? "All screens seen" : "Next unseen") { if let next { model.page = .screen(next); model.grid = false } }.disabled(next == nil).frame(minHeight: 44)
                }.padding(.horizontal, 16).background(WorkspaceStyle.canvas(scheme))
            }
        }
    }
    private func gridGroups(_ review: V2DesignReview) -> [V2ReviewGroup] {
        // The API supplies canvas page order; historical payloads have no groups.
        review.groups ?? []
    }
    private func gridTile(_ board: V2DesignReview.Board) -> some View {
        Button { model.page = .screen(board.file); model.grid = false } label: {
            VStack(alignment: .leading, spacing: 4) {
                V2ReviewCrop(preview: model.preview(board), showChanges: board.changeKind == "changed")
                    .frame(height: 122).overlay(alignment: .topLeading) {
                        HStack(spacing: 4) {
                            if board.seen == true { Image(systemName: "checkmark").accessibilityLabel("Seen").padding(4).background(.regularMaterial, in: Capsule()) }
                            let pins = model.pins.filter { $0.board == board.file && $0.noteId == nil }.count
                            if pins > 0 { Label("\(pins)", systemImage: "pin.fill").padding(4).background(.regularMaterial, in: Capsule()) }
                            Spacer(minLength: 0)
                            if board.conflict == true { Text("Conflict").padding(4).background(.regularMaterial, in: Capsule()) }
                            else if board.changeKind != "changed" { Text(board.changeKind.capitalized).padding(4).background(.regularMaterial, in: Capsule()) }
                        }.font(.caption2).padding(5)
                    }
                Text(board.name).font(.caption2).lineLimit(2, reservesSpace: true).truncationMode(.tail).padding(.horizontal, 5)
            }.frame(maxWidth: .infinity, alignment: .topLeading).padding(.bottom, 4).background(WorkspaceStyle.surface(scheme))
        }.buttonStyle(.plain).id(board.file)
    }
    private var conflictSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("\(V2ReviewModel.count(review?.conflicts?.count ?? 0, "screen")) conflict with main").font(.title2.bold())
                    ForEach(review?.boards.filter { $0.conflict == true } ?? []) { board in
                        HStack { V2ReviewCrop(preview: model.preview(board), showChanges: true).frame(width: 100, height: 100); Text(board.name); Spacer(); Text("Conflict").font(.footnote) }
                    }
                    if let error = model.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                    Button("Ask to update") { answer("update") }.buttonStyle(V2ReviewActionStyle(primary: true)).disabled(!model.decisionsReady || !store.online)
                    Button("Close") { model.conflict = false; dismiss() }.buttonStyle(V2ReviewActionStyle(primary: false))
                }.padding(24)
            }
        }
    }
    private func askForChanges() {
        guard canDecide else { return }
        if model.pins.contains(where: { !$0.resolved }) { answer("changes") } else { model.asking = true }
    }
    private func answer(_ action: String, note: String? = nil) {
        Task {
            if let outcome = await model.answer(client: store.client, action: action, note: note) {
                model.conflict = false
                completed(outcome)
                dismiss()
            }
        }
    }
}

/// Keep completion feedback on the presenting page, after the review has left.
private struct V2DesignReviewPresentation: ViewModifier {
    @Binding var item: InboxItem?
    let store: V2Store
    @State private var pendingOutcome: String?
    @State private var outcome: String?
    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: Binding(get: { item != nil }, set: { if !$0 { item = nil } }), onDismiss: {
                guard let pendingOutcome else { return }
                outcome = pendingOutcome
                self.pendingOutcome = nil
                Task { await store.refresh() }
            }) {
                if let item {
                    NavigationStack {
                        V2DesignReviewView(store: store, item: item) { pendingOutcome = $0 }
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if let outcome {
                    Text(outcome).font(.footnote).padding(12).background(.regularMaterial, in: Capsule()).padding()
                        .accessibilityAddTraits(.updatesFrequently)
                        .task(id: outcome) {
                            try? await Task.sleep(for: .seconds(5))
                            if !Task.isCancelled { self.outcome = nil }
                        }
                }
            }
    }
}
extension View {
    func designReview(item: Binding<InboxItem?>, store: V2Store) -> some View {
        modifier(V2DesignReviewPresentation(item: item, store: store))
    }
}

private struct V2ReviewActionStyle: ButtonStyle {
    let primary: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.semibold)).padding(.vertical, 8).padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(primary ? WorkspaceStyle.onAction(scheme) : WorkspaceStyle.text(scheme))
            .background(primary ? WorkspaceStyle.action(scheme) : WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
    }
}

struct V2ReviewPinSheet: View {
    @Bindable var model: V2ReviewState
    let client: V2Client
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("What should change?", text: $model.sheetText, axis: .vertical).lineLimit(3...8).padding(12)
                        .background(.background, in: RoundedRectangle(cornerRadius: 12)).focused($focused)
                    Text(context).font(.footnote).foregroundStyle(.secondary)
                    if let pin = model.editing, model.review?.item.state == .waiting {
                        if pin.resolved { Button("Reopen") { Task { await model.savePin(client: client, reopen: true) } } }
                        Button("Remove pin", role: .destructive) { Task { await model.savePin(client: client, remove: true) } }
                    }
                    if let error = model.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                }.padding(16)
            }
            .navigationTitle("Pin \(model.editing?.number ?? model.draftNumber)").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.pinSheet = false }.disabled(model.saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.editing == nil ? "Add" : "Save") { Task { await model.savePin(client: client) } }.bold()
                        .disabled(model.saving || model.sheetText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.review?.item.state != .waiting)
                }
            }.disabled(model.saving).task { focused = true }
        }
    }
    private var context: String {
        let note = model.editing?.noteId ?? model.draft?.noteId
        let board = model.editing?.board ?? model.draft?.board
        return note.flatMap { id in model.review?.changedNotes.first { $0.id == id }?.title } ?? model.review?.boards.first { $0.file == board }?.name ?? ""
    }
}
/// A canvas note's text in a review, in the colour of a note: Before marks the lines that went,
/// After the lines that are new.
struct V2NoteText: View {
    let lines: [V2DesignReview.Note.Line]?
    let after: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if let lines {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        Text(line.text)
                            .font(.system(size: 13, weight: index == 0 ? .semibold : .regular))
                            .foregroundStyle(line.marked && !after ? WorkspaceStyle.secondary(scheme) : WorkspaceStyle.text(scheme))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8).padding(.vertical, 1)
                            .background(line.marked && after ? WorkspaceStyle.surface(scheme) : .clear)
                            .overlay(alignment: .leading) {
                                if line.marked {
                                    Rectangle().fill(after ? WorkspaceStyle.accent(scheme) : WorkspaceStyle.secondary(scheme)).frame(width: 2)
                                }
                            }
                    }
                } else {
                    Text(after ? "Removed" : "Not on main").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                }
            }.padding(12)
        }
        .background(WorkspaceStyle.accentSoft(scheme), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

/// A board rendered by the coordinator at a commit and width.
struct V2BoardImage: View {
    @Bindable var store: V2Store
    let project: String
    let board: String
    let commit: String
    let width: Int
    @State private var image: UIImage?
    @State private var failed = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(WorkspaceStyle.line(scheme)))
            } else if failed {
                Text("Couldn’t draw this board").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
            } else { ProgressView() }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .task(id: "\(commit)/\(board)/\(width)") {
                image = nil; failed = false
                do {
                    let data = try await store.client.designImage(project: project, board: board, commit: commit, width: width)
                    try Task.checkCancellation()
                    image = UIImage(data: data); failed = image == nil
                } catch { if !Task.isCancelled { failed = true } }
            }
    }
}
#endif

#if os(iOS)
/// A design waiting in a task's chat or in Waiting on you: each changed board, Before and After,
/// its changes, and the decision. Tapping a board opens the full review.
struct V2DesignCard: View {
    @AppStorage(V2DesignComparison.modeKey) private var comparisonMode = "slider"
    @Bindable var store: V2Store
    let item: InboxItem
    @State private var review: V2DesignReview?
    @State private var after = true
    @State private var page = 0
    @State private var open = false
    @State private var asking = false
    @State private var note = ""
    @Environment(\.colorScheme) private var scheme
    private var project: String? { V2DesignReview.project(of: item.id) }
    private var current: InboxItem { store.snapshot.inbox.first { $0.id == item.id } ?? item }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let review, review.boards.indices.contains(page) {
                let board = review.boards[page]
                HStack(spacing: 8) {
                    Image(systemName: "square.grid.2x2").foregroundStyle(WorkspaceStyle.tertiary(scheme))
                    Text(board.name).font(.system(size: 15, weight: .semibold))
                    if review.boards.count > 1 {
                        Text("\(page + 1) of \(review.boards.count)").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                    }
                    Spacer()
                }
                TabView(selection: $page) {
                    ForEach(Array(review.boards.enumerated()), id: \.element.id) { index, item in
                        V2BoardComparison(store: store, project: project ?? "", board: item, review: review,
                                          width: item.isPhone ? 390 : 700, caption: false, open: { open = true })
                            .tag(index)
                    }
                }.tabViewStyle(.page(indexDisplayMode: .never)).frame(height: comparisonMode == "onion" && !board.added && !board.isRemoved ? 370 : 300)
                if !board.lines.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(board.lines.prefix(4), id: \.self) { line in
                            Text("• \(line)").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                        }
                    }
                }
            } else if let review, !review.changedNotes.isEmpty {
                Picker("Version", selection: $after) { Text("Before").tag(false); Text("After").tag(true) }
                    .pickerStyle(.segmented).frame(width: 150)
                ForEach(review.changedNotes) { note in
                    Text(note.title).font(.system(size: 15, weight: .semibold))
                    V2NoteText(lines: after ? note.after : note.before, after: after).frame(height: 240)
                }
            } else { ProgressView().frame(maxWidth: .infinity, minHeight: 120) }
            if let answer = current.answer {
                Text("\(V2Labels.outcome(current)) · \(answer.by)").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
            } else if current.state == .waiting {
                HStack(spacing: 8) {
                    Button("Approve") { send("approve") }.buttonStyle(V2ActionStyle(primary: true))
                    Button("Ask for changes") { asking = true }.buttonStyle(V2ActionStyle(primary: false))
                }.disabled(!store.online || store.busy)
            }
        }.padding(12).background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme), style: StrokeStyle(lineWidth: 1, dash: current.answer == nil ? [] : [4, 3])))
            .designReview(item: Binding(get: { open ? current : nil }, set: { open = $0 != nil }), store: store)
            .alert("Ask for changes", isPresented: $asking) {
                TextField("What should change?", text: $note)
                Button("Send") { send("changes", note: note) }.disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Cancel", role: .cancel) {}
            }
            .task(id: item.id) {
                guard let project else { return }
                review = try? await store.client.designReview(project: project, item: item.id)
            }
    }
    private func send(_ id: String, note: String? = nil) {
        guard let action = current.actions.first(where: { $0.id == id }) else { return }
        Task { await store.answer(current, action: action, note: note) }
    }
}
#endif
