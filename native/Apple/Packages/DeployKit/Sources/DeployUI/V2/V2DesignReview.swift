#if os(iOS)
import SwiftUI
import UIKit
import DeployCore

struct V2ReviewEvidenceView: View {
    let store: V2Store
    @State private var item: InboxItem?
    @State private var error: String?
    var body: some View {
        NavigationStack {
            if let item { V2DesignReviewView(store: store, item: item) }
            else if let error { Text(error) }
            else { ProgressView() }
        }.task {
            do {
                let waiting = try await store.client.inbox()
                let answered = try await store.client.inbox(state: "answered")
                let items = waiting + answered
                item = items.first { V2DesignReview.project(of: $0.id) != nil }
                if item == nil { error = "Reset the review fixture on port 5180 first." }
            } catch { self.error = coordinatorErrorDescription(error) }
        }
    }
}

struct V2DesignReviewView: View {
    @Bindable var store: V2Store
    let item: InboxItem
    @State private var model = V2ReviewState()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase
    @State private var openTask = false
    @State private var active = false
    @ScaledMetric(relativeTo: .title) private var coverHeadingSize = 30
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
    private var reviewPosition: (value: Double, total: Double) {
        if let board, let review {
            let rows = V2ReviewModel.rows(review)
            return (Double((rows.firstIndex { $0.screens.contains(board.file) } ?? 0) + 1), Double(max(1, rows.count)))
        }
        return (Double(pages.firstIndex(of: model.page) ?? 0), Double(max(1, pages.count - 1)))
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
                } else if reduceMotion {
                    steadyPage(review).simultaneousGesture(DragGesture(minimumDistance: 40).onEnded { value in
                        guard !model.comparing, !model.drawing, !model.obscured, model.pagingAllowed,
                              abs(value.translation.width) > abs(value.translation.height), let index = pages.firstIndex(of: model.page) else { return }
                        let next = index + (value.translation.width < 0 ? 1 : -1)
                        if pages.indices.contains(next) { model.page = pages[next] }
                    })
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
                    V2ReviewShimmer().frame(height: 68).clipShape(RoundedRectangle(cornerRadius: 8))
                    V2ReviewShimmer().frame(height: 120).clipShape(RoundedRectangle(cornerRadius: 8))
                    Text("Loading screens…").font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                }.padding(24)
            }
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(WorkspaceStyle.danger(scheme)).padding(12) }
        }
        .background(WorkspaceStyle.canvas(scheme))
        .tint(WorkspaceStyle.text(scheme))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { if model.drawing { model.cancelDrawing() } else if model.comparing { model.comparing = false } else if model.page == .cover { dismiss() } else { model.page = .cover } } label: { Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("Back")
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    Text(model.drawing && !model.pinSheet ? "Draw a comment" : board?.name ?? note?.title ?? (model.page == .decide ? "Finish review" : "Design review")).font(.headline).lineLimit(1).truncationMode(.tail)
                    if let board {
                        Text(model.drawing && !model.pinSheet ? "\(board.name) · \(screenCounter(board))" : "\(board.changeKind == "new" ? "New · " : board.isRemoved ? "Removed · " : "")\(screenCounter(board))").font(.footnote).foregroundStyle(.secondary)
                    } else if let note, let index = review?.changedNotes.firstIndex(where: { $0.id == note.id }) {
                        Text("Note \(index + 1) of \(review?.changedNotes.count ?? 0)").font(.footnote).foregroundStyle(.secondary)
                    }
                }.accessibilityElement(children: .combine)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if model.page == .cover { Button("See all screens") { model.grid = true } }
                    else {
                        Button("Approve design") { approve() }.disabled(!canDecide)
                        Button("Ask for changes") { model.finishReview() }.disabled(!canDecide)
                    }
                    if board != nil || note != nil {
                        Button("Place a pin") { if let board { model.placePin(board) } else { model.pinTool = true } }.disabled(model.comparing || model.drawing || review?.item.state != .waiting || (board != nil && board.flatMap(model.preview) == nil))
                        Button("All screens") { model.grid = true }
                    }
                    Button("Open the Design page") { model.design = true }
                } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("More").disabled(model.drawing)
            }
        }
        .sheet(isPresented: $openTask) { V2ConversationView(store: store, taskId: review?.task ?? item.taskId) }
        .sheet(isPresented: $model.grid) { gridSheet.presentationDetents([.large]).presentationDragIndicator(.visible) }
        .sheet(isPresented: $model.pinSheet, onDismiss: { model.dismissPinSheet() }) {
            V2ReviewPinSheet(model: model, client: store.client).presentationDetents([.medium, .large]).presentationDragIndicator(.visible).interactiveDismissDisabled(model.saving)
        }
        .sheet(isPresented: $model.approvalCheck) {
            VStack(alignment: .leading, spacing: 8) {
                let count = model.pins.filter { !$0.resolved }.count + (model.sheetText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 1)
                Text(count == 1 ? "1 note hasn’t been sent" : "\(count) notes haven’t been sent").font(.headline)
                Text("Approving puts this on main and drops your note. You can undo for 30 seconds.").font(.subheadline).foregroundStyle(.secondary)
                Button(count == 1 ? "Send note" : "Send notes") {
                    Task {
                        if model.draft != nil && !model.sheetText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            await model.savePin(client: store.client)
                            guard model.draft == nil else { return }
                        }
                        model.approvalCheck = false; model.finishReview(); answer("changes")
                    }
                }.buttonStyle(V2ReviewActionStyle(primary: true)).disabled(!canDecide)
                Button("Approve anyway") { model.approvalCheck = false; answer("approve") }
                    .buttonStyle(V2ReviewActionStyle(primary: false)).disabled(!canDecide)
            }.padding(20).presentationDetents([.height(260)]).presentationDragIndicator(.visible)
        }
        .task(id: "\(review?.landing?.state ?? "")-\(model.approvalAwaitingRefresh)") {
            while (model.review?.landing?.state == "pending" || model.approvalAwaitingRefresh), !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)); try Task.checkCancellation() } catch { return }
                await model.refreshApproval(client: store.client)
            }
        }
        .sheet(isPresented: $model.conflict) { conflictSheet.presentationDetents([.medium, .large]) }
        .fullScreenCover(isPresented: $model.design) { V2DesignView(connection: store.connection, projectId: model.project) }
        .alert("Ask for changes", isPresented: $model.asking) {
            TextField("What should change?", text: $model.note)
            Button("Send") { answer("changes", note: model.note) }.disabled(model.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !canDecide)
            Button("Cancel", role: .cancel) {}
        }
        .task(id: "\(item.id)@\(displayScale)") {
            await model.load(client: store.client, item: item, scale: displayScale)
            if V2Evidence.reviewBoard {
                prepareEvidence()
                await V2Evidence.reviewReady(failed: model.failed.count + (model.review == nil ? 1 : 0))
            }
        }
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
        .onChange(of: model.page) { _, _ in model.pinTool = false; model.areaTool = false; model.amount = 1; model.pagingAllowed = true; model.comparing = false; model.peeking = false; model.selectedPin = nil }
        .transaction { if reduceMotion { $0.animation = nil; $0.disablesAnimations = true } }
    }

    @ViewBuilder private func steadyPage(_ review: V2DesignReview) -> some View {
        switch model.page {
        case .cover: cover(review)
        case .decide: decide(review)
        case .screen: if let board { screenPage(board) }
        case .note: if let note { V2ReviewNotePage(model: model, note: note) }
        }
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
                    Text(review.summary ?? review.proposer?.missingSummary ?? "No summary. Ask \(V2Labels.agentName(review.item)) to add one")
                        .font(.body).foregroundStyle(WorkspaceStyle.secondary(scheme)).fixedSize(horizontal: false, vertical: true)
                    if (review.round ?? 1) > 1 { pinList(review, replies: true) }
                    else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(review.proposer?.name ?? V2Labels.agentName(review.item)) · \(V2ReviewModel.age(review.createdAt ?? review.item.createdAt))")
                            Text("\(V2ReviewModel.count(review.boards.count, "screen")) · \(V2ReviewModel.count(V2ReviewModel.rows(review).count, "different change"))")
                            if let updated = review.updatedWithMainAt, review.stale != true { Text("Updated with main \(V2ReviewModel.age(updated)) · no conflicts") }
                        }.font(.footnote).foregroundStyle(.secondary)
                        if !review.boards.allSatisfy({ model.preview($0) != nil }) {
                            V2ReviewLoadingLine(total: review.boards.count, loaded: review.boards.filter { model.preview($0) != nil }.count)
                        }
                        VStack(spacing: 0) {
                            ForEach(V2ReviewModel.rows(review)) { row in
                                Button { if let file = row.screens.first { model.page = .screen(file) } } label: {
                                    HStack(spacing: 12) {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(row.title).font(.body.weight(.medium)).foregroundStyle(WorkspaceStyle.text(scheme))
                                            Text(row.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                                    }.padding(.horizontal, 16).padding(.vertical, 14)
                                }.buttonStyle(.plain)
                                if row.id != V2ReviewModel.rows(review).last?.id { Divider().padding(.leading, 16) }
                            }
                        }.background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))

                    }
                }.padding(.horizontal, 24).padding(.top, 16)
            }
            VStack(spacing: 6) {
                if review.stale == true {
                    Button(V2ReviewModel.conflictCount(review.conflicts ?? [])) { model.conflict = true }.buttonStyle(V2ReviewActionStyle(primary: false))
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
                    Text("You’ve looked at\n\(V2ReviewModel.progress(review))")
                        .font(.system(size: headingSize, weight: .bold)).tracking(-0.6)
                    if let notice = V2ReviewModel.sentNotice(review) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(notice.title).font(.headline)
                            Text(notice.body).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    pinList(review, replies: false)
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
            VStack(spacing: 6) {
                if model.loading || model.checking || !model.loadingKeys.isEmpty { V2ReviewLoadingLine(total: review.boards.count, loaded: review.boards.filter { model.preview($0) != nil }.count) }
                if model.approvalAwaitingRefresh {
                    Text("Loading the review…").font(.footnote).foregroundStyle(.secondary)
                } else if let answer = review.item.answer {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(V2ReviewModel.outcome(review, now: context.date)).font(.footnote).foregroundStyle(.secondary)
                    }
                    if answer.actionId == "approve" {
                        if review.landing?.state == "pending" {
                            Button("Undo") { Task { await model.undoApproval(client: store.client); await store.refresh() } }
                                .buttonStyle(V2ReviewActionStyle(primary: false)).disabled(model.saving || (review.landing?.secondsRemaining ?? 0) == 0)
                        } else { Button("Open in Design") { model.design = true }.buttonStyle(V2ReviewActionStyle(primary: false)) }
                    } else if review.task ?? item.taskId != nil {
                        Button("Open the task") { openTask = true }.buttonStyle(V2ReviewActionStyle(primary: false))
                    }
                } else if review.stale == true {
                    Button("Ask to update") { model.conflict = true }.buttonStyle(V2ReviewActionStyle(primary: true))
                    Button("Close") { dismiss() }.frame(minHeight: 44)
                } else {
                    let primary = V2ReviewModel.primaryAction(review)
                    Button(primary.title) { if primary == .approve { approve() } else { askForChanges() } }.buttonStyle(V2ReviewActionStyle(primary: true)).disabled(!canDecide)
                    Button(primary == .approve ? "Ask for changes" : "Approve design") { if primary == .approve { askForChanges() } else { approve() } }.buttonStyle(V2ReviewActionStyle(primary: false)).disabled(!canDecide)
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
                                    .foregroundStyle(pin.resolved ? WorkspaceStyle.success(scheme) : WorkspaceStyle.secondary(scheme))
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
        VStack(spacing: 2) {
            if model.drawing && !model.pinSheet {
                HStack {
                    Button("Cancel") { model.cancelDrawing() }.frame(minWidth: 60, minHeight: 44)
                    Spacer()
                    Button { model.undoStroke() } label: { Label("Undo", systemImage: "arrow.uturn.backward") }.frame(minWidth: 60, minHeight: 44).disabled(model.draft?.drawing?.strokes.isEmpty != false)
                    Spacer()
                    Button("Next") { model.commentOnDrawing() }.bold().frame(minWidth: 60, minHeight: 44).disabled(model.draft?.drawing?.strokes.isEmpty != false)
                }
                Text("Draw with your finger. Two fingers to pan.").font(.footnote).foregroundStyle(.secondary).padding(.top, 6)
            } else if let board, let review, !board.added && !board.isRemoved {
                if let row = V2ReviewModel.row(review, file: board.file) {
                    (Text("\(row.title) · \(V2ReviewModel.count(row.screens.count, "screen")). ").bold() + Text(styledWords(row)))
                        .font(.footnote).frame(maxWidth: .infinity, alignment: .leading).lineLimit(3)
                }
                if model.canCompare(board) {
                    HStack(spacing: 16) {
                        Text("Old").frame(minHeight: 44)
                            .onLongPressGesture(minimumDuration: 0.3, pressing: { model.peeking = $0 }, perform: {})
                            .accessibilityHint("Hold to show Old; release to restore the comparison")
                        Slider(value: $model.amount, in: 0...1).accessibilityLabel("Old to new")
                            .accessibilityValue("\(Int(model.amount * 100)) percent New")
                        Text("New")
                    }.font(.footnote).frame(minHeight: 44)
                } else { Text(board.added ? "New screen · nothing to compare" : "Removed screen · old only").font(.footnote).foregroundStyle(.secondary) }
                HStack(spacing: 8) {
                    tool("Pin", "mappin", selected: model.pinTool) { model.pinTool.toggle(); model.areaTool = false; model.amount = 1 }
                    tool("Area", "rectangle.dashed", selected: model.areaTool) { model.areaTool.toggle(); model.pinTool = false; model.amount = 1 }
                    tool("Draw", "pencil") { model.startDrawing(board) }
                    Spacer()
                    if model.canCompare(board) {
                        Menu {
                            Button("Overlay") { model.comparisonMode = "onion" }
                            Button("Wipe") { model.comparisonMode = "slider" }
                        } label: { Text(model.comparisonMode == "onion" ? "Overlay ⌄" : "Wipe ⌄").font(.subheadline).frame(minHeight: 44) }
                    }
                }.disabled(review.item.state != .waiting || model.preview(board) == nil)
                let rows = V2ReviewModel.rows(review)
                let index = rows.firstIndex { $0.screens.contains(board.file) } ?? 0
                HStack {
                    Text("\(index + 1) of \(V2ReviewModel.count(rows.count, "change"))")
                    Spacer(); Text("Pinch to zoom")
                }.font(.footnote).foregroundStyle(.secondary)
                ProgressView(value: Double(index + 1), total: Double(max(1, rows.count))).tint(WorkspaceStyle.text(scheme)).accessibilityLabel("Review position")
            } else {
                HStack(spacing: 8) {
                    if let board {
                        V2ReviewCompareControl(selected: model.comparing, enabled: model.canCompare(board), reason: compareReason(board),
                                               tap: { model.toggleCompare(board) }, hold: { model.peeking = $0 })
                            .frame(width: 106, height: 44)
                        tool("Draw and comment", "pencil") { model.startDrawing(board) }.disabled(review?.item.state != .waiting || model.preview(board) == nil)
                    }
                    tool("Show changes", "square.lefthalf.filled", selected: model.showChanges) { model.showChanges.toggle(); model.selectedPin = nil }
                        .disabled(board.map { $0.changeKind != "changed" } ?? (note?.before == nil || note?.after == nil))
                    Spacer(minLength: 0)
                    if let board {
                        if board.previewWidths.count > 1 {
                            Menu { ForEach(board.previewWidths, id: \.self) { width in Button(String(width)) { model.selectWidth(width, board: board) } } } label: { widthLabel(board) }.disabled(model.drawing)
                        } else { widthLabel(board) }
                    }
                    if model.comparing { Button("Done") { model.comparing = false }.font(.subheadline.bold()).frame(minWidth: 48, minHeight: 44) }
                }
                HStack(spacing: 8) {
                    Text(board.map(compareReason).flatMap { $0.isEmpty ? nil : $0 } ?? (model.comparing ? "Drag anywhere to compare" : "Long-press to pin"))
                    Spacer(minLength: 0)
                    let seen = board?.seen == true || note.map { model.seenNotes.contains($0.id) } == true
                    let pins = model.pins.filter { pin in board.map { pin.board == $0.file && pin.noteId == nil } ?? (pin.noteId == note?.id) }.count
                    HStack(spacing: 4) {
                        if seen { Image(systemName: "checkmark") }
                        Text("\(seen ? "Seen" : "Not seen")\(pins == 0 && board?.changeKind != "changed" ? "" : " · \(V2ReviewModel.count(pins, "pin"))")")
                    }
                }.font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                ProgressView(value: reviewPosition.value, total: reviewPosition.total)
                    .tint(WorkspaceStyle.text(scheme)).accessibilityLabel("Review position").padding(.top, 8)
            }
        }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12).overlay(alignment: .top) { Divider() }
    }
    private func styledWords(_ row: V2ReviewRow) -> AttributedString {
        var words = AttributedString(row.words)
        guard row.changeWords == nil else { return words }
        if let start = words.range(of: "Added ") {
            let end = words.range(of: ". Removed ")?.lowerBound ?? words.index(beforeCharacter: words.endIndex)
            if start.upperBound < end { words[start.upperBound..<end].backgroundColor = WorkspaceStyle.accentSoft(scheme) }
        }
        if let start = words.range(of: "Removed ") {
            let end = words.index(beforeCharacter: words.endIndex)
            if start.upperBound < end {
                words[start.upperBound..<end].strikethroughStyle = .single
                words[start.upperBound..<end].foregroundColor = WorkspaceStyle.tertiary(scheme)
            }
        }
        return words
    }
    private func prepareEvidence() {
        guard let review, let state = V2Evidence.board else { return }
        if state == "DesignReviewPhone" || state == "DesignReviewRound2Phone" { return }
        model.page = .screen(screens.first?.file ?? "")
        if state == "DesignReviewNewPhone", let board = screens.first(where: { $0.added }) { model.page = .screen(board.file) }
        if state == "DesignReviewGridPhone" { model.grid = true }
        if state == "DesignReviewDecidePhone" || state == "DesignReviewApprovedPhone" { model.page = .decide }
        if state == "DesignReviewApproveCheckPhone" { model.approvalCheck = true }
        if state == "DesignReviewHoldPhone" { model.peeking = true }
        if let board, state == "DesignReviewPinPhone" { model.placePin(board) }
        if let board, ["DesignReviewDrawPhone", "DesignReviewDrawCommentPhone", "DesignReviewDrawSavedPhone"].contains(state) {
            model.startDrawing(board)
            model.appendStroke([.init(x: 0.03, y: 0.08), .init(x: 0.2, y: 0.08)])
            if state != "DesignReviewDrawPhone" { model.commentOnDrawing(); model.sheetText = "Keep the project name bold." }
            if state == "DesignReviewDrawSavedPhone" { Task { await model.savePin(client: store.client) } }
        }
        if state == "DesignReviewNotePhone", let note = review.changedNotes.first { model.page = .note(note.id) }
    }
    private func approve() {
        if model.requestApproval() { answer("approve") }
    }
    private func compareReason(_ board: V2DesignReview.Board) -> String {
        board.isRemoved ? "No After for this screen" : board.added ? "No Before for this screen" : ""
    }
    private func widthLabel(_ board: V2DesignReview.Board) -> some View {
        Text(String(model.width(board))).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 9).padding(.vertical, 2)
            .overlay(Capsule().stroke(WorkspaceStyle.line(scheme))).frame(minWidth: 50, minHeight: 44).accessibilityLabel("Preview width, \(model.width(board))")
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
                    Text("\(review.map(V2ReviewModel.progress) ?? "0 of 0") changes seen").font(.footnote).foregroundStyle(.secondary)
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
                    Text(V2ReviewModel.conflictCount(review?.conflicts ?? [])).font(.title2.bold())
                    if let review, !review.boards.allSatisfy({ model.preview($0) != nil }) {
                        V2ReviewLoadingLine(total: review.boards.count, loaded: review.boards.filter { model.preview($0) != nil }.count)
                    }
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
            if await model.answer(client: store.client, action: action, note: note) != nil {
                if action == "update" { dismiss(); return }
                model.conflict = false
                model.asking = false
                model.page = .decide
                await store.refresh()
            }
        }
    }
}

/// The decision stays in the review; refresh the presenting page when it closes.
private struct V2DesignReviewPresentation: ViewModifier {
    @Binding var item: InboxItem?
    let store: V2Store
    func body(content: Content) -> some View {
        content.fullScreenCover(isPresented: Binding(get: { item != nil }, set: { if !$0 { item = nil } }), onDismiss: {
            Task { await store.refresh() }
        }) {
            if let item { NavigationStack { V2DesignReviewView(store: store, item: item) } }
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
                    if let drawing = model.editing?.drawing ?? model.draft?.drawing {
                        HStack(spacing: 12) {
                            V2ReviewDrawingThumbnail(model: model, drawing: drawing, client: client).frame(width: 112, height: 84).clipShape(RoundedRectangle(cornerRadius: 8))
                            VStack(alignment: .leading, spacing: 4) {
                                Text(context)
                                Text("Drawing · Pin \(model.editing?.number ?? model.draftNumber)").foregroundStyle(.secondary)
                            }.font(.footnote)
                        }
                    }
                    TextField("What should change?", text: $model.sheetText, axis: .vertical).lineLimit(3...8).padding(12)
                        .background(.background, in: RoundedRectangle(cornerRadius: 12)).focused($focused)
                    if model.editing?.drawing == nil && model.draft?.drawing == nil { Text(context).font(.footnote).foregroundStyle(.secondary) }
                    if let pin = model.editing, model.review?.item.state == .waiting {
                        if pin.resolved { Button("Reopen") { Task { await model.savePin(client: client, reopen: true) } } }
                        Button("Remove pin", role: .destructive) { Task { await model.savePin(client: client, remove: true) } }
                    }
                    if let error = model.error {
                        Text(error).font(.footnote).foregroundStyle(.secondary)
                        Button("Retry") { Task { await model.savePin(client: client) } }.disabled(model.sheetText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }.padding(16)
            }
            .navigationTitle(model.editing?.drawing != nil || model.draft?.drawing != nil ? "Comment" : "Pin \(model.editing?.number ?? model.draftNumber)").navigationBarTitleDisplayMode(.inline)
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
/// A changed screen in chat, Before and After. Decisions belong to the full review.
struct V2DesignCard: View {
    @Bindable var store: V2Store
    let item: InboxItem
    @State private var model = V2ReviewState()
    @State private var open = false
    @State private var after = true
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale
    private var current: InboxItem { store.snapshot.inbox.first { $0.id == item.id } ?? item }
    private var boards: [V2DesignReview.Board] { model.review.map(V2ReviewModel.canvasBoards) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "square.grid.2x2").foregroundStyle(WorkspaceStyle.tertiary(scheme))
                Text(boards.first?.name ?? item.title).font(.system(size: 13, weight: .semibold))
                if !boards.isEmpty {
                    Text("1 of \(V2ReviewModel.count(boards.count, "screen")) changed")
                        .font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                }
                Spacer(minLength: 0)
            }.padding(.horizontal, 12).padding(.vertical, 10)
            Divider()
            if let review = model.review, boards.isEmpty, !review.changedNotes.isEmpty {
                // Keep the existing note preview for proposals without a changed screen.
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Version", selection: $after) { Text("Before").tag(false); Text("After").tag(true) }
                        .pickerStyle(.segmented).frame(width: 150)
                    ForEach(review.changedNotes) { note in
                        Text(note.title).font(.system(size: 15, weight: .semibold))
                        V2NoteText(lines: after ? note.after : note.before, after: after).frame(height: 240)
                    }
                }.padding(12)
            } else {
                HStack(alignment: .top, spacing: 10) {
                    if let board = boards.first {
                        if !board.added { shot(board, side: "before", caption: "Before · main") }
                        if !board.isRemoved { shot(board, side: "after", caption: "After · this task") }
                    } else {
                        V2ReviewShimmer().frame(height: 120)
                    }
                }.padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 10)
            }
            Divider()
            Button("Review") { open = true }.buttonStyle(V2ActionStyle(primary: true)).padding(12)
        }.background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain).accessibilityLabel("Design change")
            .designReview(item: Binding(get: { open ? current : nil }, set: { open = $0 != nil }), store: store)
            .task(id: item.id) {
                guard let project = item.projectId ?? V2DesignReview.project(of: item.id) else { return }
                model.displayScale = min(3, max(1, displayScale))
                model.review = try? await store.client.designReview(project: project, item: item.id)
                if let board = boards.first {
                    // The phone board shows a web screen at its narrow width.
                    model.widths[board.file] = board.previewWidths.contains(700) ? 700 : board.defaultWidth
                    await model.loadPreview(client: store.client, board: board)
                }
            }
    }
    private func shot(_ board: V2DesignReview.Board, side: String, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            V2ReviewCrop(preview: model.preview(board), showChanges: false, side: side, card: true)
                .frame(height: 120).clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
            Text(caption).font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
#endif
