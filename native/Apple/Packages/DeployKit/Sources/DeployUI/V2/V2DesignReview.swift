#if os(iOS)
import SwiftUI
import UIKit
import DeployCore

/// Approving a design from Waiting on you: Before and After of each changed board, what changes,
/// and the decision. Boards come rendered by the coordinator, so the phone draws no web page.
struct V2DesignReviewView: View {
    @Bindable var store: V2Store
    let item: InboxItem
    @State private var review: V2DesignReview?
    @State private var error: String?
    @State private var after = true
    @State private var page = 0
    @State private var viewing: Int?
    @State private var asking = false
    @State private var note = ""
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    private var project: String? { V2DesignReview.project(of: item.id) }
    private var current: InboxItem { store.snapshot.inbox.first { $0.id == item.id } ?? item }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(current.title).font(.system(size: 22, weight: .semibold)).tracking(-0.3)
                if let review {
                    Text(source(review)).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                    Picker("Version", selection: $after) {
                        Text("Before").tag(false)
                        Text("After").tag(true)
                    }.pickerStyle(.segmented).frame(width: 150).frame(maxWidth: .infinity)
                    TabView(selection: $page) {
                        ForEach(Array(review.boards.enumerated()), id: \.element.id) { index, board in
                            Button { viewing = index } label: {
                                V2BoardImage(store: store, project: project ?? "", board: board.file,
                                             commit: after || board.added ? review.after : review.before,
                                             width: board.isPhone ? 390 : 720)
                            }.buttonStyle(.plain).tag(index)
                                .accessibilityLabel("\(board.name), \(after ? "After" : "Before"). Opens the board.")
                        }
                    }.tabViewStyle(.page(indexDisplayMode: review.boards.count > 1 ? .always : .never))
                        .frame(height: 300)
                        .padding(10)
                        .background(WorkspaceStyle.sidebar(scheme), in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
                    if review.boards.indices.contains(page) {
                        let board = review.boards[page]
                        Text("\(board.name) · \(after ? "After" : "Before") · \(board.isPhone ? "phone" : "narrow")")
                            .font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).frame(maxWidth: .infinity)
                        if !board.lines.isEmpty {
                            Text("What changes").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 12)
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(board.lines, id: \.self) { line in
                                    Text(line).font(.system(size: 15)).frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }.padding(12).background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
                        }
                    }
                } else if let error {
                    Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme))
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 300)
                }
            }.padding(16)
        }
        .safeAreaInset(edge: .bottom) { decision }
        .background(WorkspaceStyle.canvas(scheme))
        .navigationTitle("Design review").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Done") { dismiss() }
                } label: { Image(systemName: "ellipsis") }.accessibilityLabel("More")
            }
        }
        .navigationDestination(isPresented: Binding(get: { viewing != nil }, set: { if !$0 { viewing = nil } })) {
            if let review, let viewing { V2DesignBoardView(store: store, project: project ?? "", review: review, index: viewing) }
        }
        .alert("Ask for changes", isPresented: $asking) {
            TextField("What should change?", text: $note)
            Button("Send") { send("changes", note: note) }.disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: { Text("The note goes to the board's comments and, for an agent's task, to the agent.") }
        .task(id: item.id) { await load() }
    }

    @ViewBuilder private var decision: some View {
        VStack(spacing: 8) {
            if let answer = current.answer {
                Text("\(V2Labels.outcome(current)) · \(answer.by)")
                    .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).frame(maxWidth: .infinity)
            } else if current.state == .waiting {
                Button("Approve design") { send("approve") }.buttonStyle(V2ActionStyle(primary: true))
                Button("Ask for changes") { asking = true }.buttonStyle(V2ActionStyle(primary: false))
            }
            if store.online, let error = store.error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
        }.disabled(!store.online || store.busy).padding(.horizontal, 16).padding(.vertical, 10).background(WorkspaceStyle.canvas(scheme))
    }

    private func source(_ review: V2DesignReview) -> String {
        let boards = "\(review.boards.count) board\(review.boards.count == 1 ? "" : "s")"
        return review.task.map { "From the task “\($0)” · \(boards)" } ?? "From \(review.branch) · \(boards)"
    }
    private func send(_ id: String, note: String? = nil) {
        guard let action = current.actions.first(where: { $0.id == id }) else { return }
        Task { await store.answer(current, action: action, note: note) }
    }
    private func load() async {
        guard let project else { error = "This review names no project."; return }
        do { review = try await store.client.designReview(project: project, item: item.id); error = nil }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}

/// One changed board, a screen at a time: its widths, its notes, and the next board by swipe.
struct V2DesignBoardView: View {
    @Bindable var store: V2Store
    let project: String
    let review: V2DesignReview
    @State var index: Int
    @State private var width: Int?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let board = review.boards[index]
        let shown = width ?? (board.isPhone ? 390 : 720)
        VStack(spacing: 14) {
            Picker("Width", selection: Binding(get: { shown }, set: { width = $0 })) {
                Text("Phone 390").tag(390)
                Text("Web 720").tag(720)
                Text("Web 1440").tag(1440)
            }.pickerStyle(.segmented).padding(.horizontal, 16)
            TabView(selection: $index) {
                ForEach(Array(review.boards.enumerated()), id: \.element.id) { offset, item in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            V2BoardImage(store: store, project: project, board: item.file, commit: review.after, width: shown)
                                .frame(height: 420)
                                .padding(10)
                                .background(WorkspaceStyle.sidebar(scheme), in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
                            if let notes = item.notes {
                                Text("Notes").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 12)
                                Text(notes).font(.system(size: 15)).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
                            }
                        }.padding(.horizontal, 16)
                    }.tag(offset)
                }
            }.tabViewStyle(.page(indexDisplayMode: .always))
            HStack {
                Button { index = max(0, index - 1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                    .disabled(index == 0).accessibilityLabel("Previous screen")
                Spacer()
                Text("Swipe for the next screen").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                Spacer()
                Button { index = min(review.boards.count - 1, index + 1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }
                    .disabled(index == review.boards.count - 1).accessibilityLabel("Next screen")
            }.buttonStyle(.bordered).buttonBorderShape(.circle).padding(.horizontal, 16).padding(.bottom, 8)
        }
        .background(WorkspaceStyle.canvas(scheme))
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(board.title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    if let page = board.page, let at = board.index, let count = board.count {
                        Text("\(page) · \(at) of \(count)").font(.system(size: 12)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                    }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
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
                do { image = UIImage(data: try await store.client.designImage(project: project, board: board, commit: commit, width: width)) ; failed = image == nil }
                catch { failed = true }
            }
    }
}
#endif

#if os(iOS)
/// A design waiting in a task's chat or in Waiting on you: each changed board, Before and After,
/// its changes, and the decision. Tapping a board opens the full review.
struct V2DesignCard: View {
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
                    Picker("Version", selection: $after) { Text("Before").tag(false); Text("After").tag(true) }
                        .pickerStyle(.segmented).frame(width: 130)
                }
                TabView(selection: $page) {
                    ForEach(Array(review.boards.enumerated()), id: \.element.id) { index, item in
                        Button { open = true } label: {
                            V2BoardImage(store: store, project: project ?? "", board: item.file,
                                         commit: after || item.added ? review.after : review.before,
                                         width: item.isPhone ? 390 : 720)
                        }.buttonStyle(.plain).tag(index)
                    }
                }.tabViewStyle(.page(indexDisplayMode: .never)).frame(height: 260)
                    .padding(8).background(WorkspaceStyle.sidebar(scheme), in: RoundedRectangle(cornerRadius: 10))
                if !board.lines.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(board.lines.prefix(4), id: \.self) { line in
                            Text("• \(line)").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                        }
                    }
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
            .sheet(isPresented: $open) { NavigationStack { V2DesignReviewView(store: store, item: current) } }
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
