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
    @State private var designPage = false
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
                    ForEach(Array(review.boards.enumerated()), id: \.element.id) { index, board in
                        if board.added || board.isRemoved {
                            Button { viewing = index } label: {
                                V2SingleBoardRow(store: store, project: project ?? "", board: board, review: review)
                            }.buttonStyle(.plain)
                        } else {
                            V2BoardComparison(store: store, project: project ?? "", board: board,
                                              review: review, width: board.isPhone ? 390 : 700,
                                              open: { viewing = index })
                        }
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
                    if !review.changedNotes.isEmpty {
                        Picker("Version", selection: $after) {
                            Text("Before").tag(false)
                            Text("After").tag(true)
                        }.pickerStyle(.segmented).frame(width: 150).frame(maxWidth: .infinity)
                        TabView(selection: $page) {
                            ForEach(Array(review.changedNotes.enumerated()), id: \.element.id) { offset, note in
                                V2NoteText(lines: after ? note.after : note.before, after: after).tag(offset)
                            }
                        }.tabViewStyle(.page(indexDisplayMode: .never)).frame(height: 340)
                        if review.changedNotes.indices.contains(page) {
                            let note = review.changedNotes[page]
                            Text("\(note.title) · \(after ? "After" : "Before") · note")
                                .font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).frame(maxWidth: .infinity)
                            Text("What changes").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 12)
                            VStack(alignment: .leading, spacing: 8) {
                                Text(note.after == nil ? "The note is removed" : "\(note.changed) of \(note.total) lines rewritten; the marked lines are new")
                                    .font(.system(size: 15)).frame(maxWidth: .infinity, alignment: .leading)
                                if review.boards.isEmpty { Text("No board changes").font(.system(size: 15)) }
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
            ToolbarItem(placement: .topBarLeading) {
                Button { dismiss() } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Back")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Open the Design page") { designPage = true }
                } label: { Image(systemName: "ellipsis") }.accessibilityLabel("More")
            }
        }
        .fullScreenCover(isPresented: $designPage) { V2DesignView(connection: store.connection, projectId: project ?? "") }
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
        let count = { (n: Int, one: String) in "\(n) \(one)\(n == 1 ? "" : "s")" }
        let what = [
            review.boards.isEmpty && !review.changedNotes.isEmpty ? nil : count(review.boards.count, "board"),
            review.changedNotes.isEmpty ? nil : count(review.changedNotes.count, "note"),
        ].compactMap { $0 }.joined(separator: " · ")
        return review.task.map { "\($0) · \(what)" } ?? "\(review.branch) · \(what)"
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

/// One changed board, a screen at a time: its widths, its notes, and the next board by swipe.
struct V2DesignBoardView: View {
    @Bindable var store: V2Store
    let project: String
    let review: V2DesignReview
    @State var index: Int
    @State private var width: Int?
    @State private var designPage = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let board = review.boards[index]
        let shown = width ?? (board.isPhone ? 390 : 700)
        VStack(spacing: 14) {
            Picker("Width", selection: Binding(get: { shown }, set: { width = $0 })) {
                Text("Phone 390").tag(390)
                Text("Web 700").tag(700)
                Text("Web 1440").tag(1440)
            }.pickerStyle(.segmented).frame(width: 250)
            TabView(selection: $index) {
                ForEach(Array(review.boards.enumerated()), id: \.element.id) { offset, item in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            V2BoardComparison(store: store, project: project, board: item, review: review,
                                              width: width ?? (item.isPhone ? 390 : 700), height: 420)
                            if let notes = item.notes {
                                Text("Notes").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 12)
                                Text(notes).font(.system(size: 15)).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
                            }
                        }.padding(.horizontal, 16)
                    }.tag(offset)
                }
            }.tabViewStyle(.page(indexDisplayMode: .never))
            if review.boards.count > 1 {
                HStack(spacing: 6) {
                    ForEach(review.boards.indices, id: \.self) { dot in
                        Circle().fill(dot == index ? WorkspaceStyle.text(scheme) : WorkspaceStyle.tertiary(scheme).opacity(0.4)).frame(width: 6, height: 6)
                    }
                }.accessibilityHidden(true)
            }
            HStack {
                Button { index = max(0, index - 1) } label: { step("chevron.left") }
                    .disabled(index == 0).accessibilityLabel("Previous screen")
                Spacer()
                Text("Swipe for the next screen").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                Spacer()
                Button { index = min(review.boards.count - 1, index + 1) } label: { step("chevron.right") }
                    .disabled(index == review.boards.count - 1).accessibilityLabel("Next screen")
            }.buttonStyle(.plain).padding(.horizontal, 16).padding(.vertical, 10)
                .overlay(alignment: .top) { Rectangle().fill(WorkspaceStyle.line(scheme)).frame(height: 1) }
        }
        .background(WorkspaceStyle.canvas(scheme))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Open the Design page") { designPage = true }
                } label: { Image(systemName: "ellipsis") }.accessibilityLabel("More")
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    // The board's name, and which layout of it is showing.
                    Text(board.isPhone || shown != 700 ? board.name : "\(board.name), narrow").font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    if let page = board.page, let at = board.index, let count = board.count {
                        Text("\(page) · \(at) of \(count)").font(.system(size: 12)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                    }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: $designPage) { V2DesignView(connection: store.connection, projectId: project) }
    }
    private func step(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(WorkspaceStyle.text(scheme))
            .frame(width: 44, height: 44).background(WorkspaceStyle.line(scheme), in: Circle())
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
            .fullScreenCover(isPresented: $open) { NavigationStack { V2DesignReviewView(store: store, item: current) } }
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
