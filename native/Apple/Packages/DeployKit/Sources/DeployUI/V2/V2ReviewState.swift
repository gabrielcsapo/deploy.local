#if os(iOS)
import SwiftUI
import UIKit
import DeployCore

@MainActor @Observable
final class V2ReviewState {
    struct Preview {
        let metadata: V2ReviewPreview
        let before: UIImage?
        let after: UIImage?
    }
    var review: V2DesignReview?
    var previews: [String: Preview] = [:]
    var displayScale: Double = 1
    var widths: [String: Int] = [:]
    var loading = true
    var checking = false
    var saving = false
    var error: String?
    var failed = Set<String>()
    var loadingKeys = Set<String>()
    var seenNotes = Set<String>()
    var page = V2ReviewModel.Page.cover
    var grid = false
    var gridAnchor: String?
    var design = false
    var conflict = false
    var asking = false
    var showChanges = true
    var pinTool = false
    var draft: V2ReviewPinDraft?
    var editing: V2ReviewPin?
    var pinSheet = false
    var sheetText = ""
    var note = ""
    var pins: [V2ReviewPin] { review?.pins ?? [] }
    var project: String { review?.projectId ?? review.flatMap { V2DesignReview.project(of: $0.item.id) } ?? "" }
    var decisionsReady: Bool {
        guard let review, review.pins != nil, review.stale != nil, review.item.state == .waiting else { return false }
        // A conflict's Close and Ask to update wait only for the conflict check, not for previews.
        if review.stale == true { return !loading && !checking && !saving }
        return !loading && !checking && !saving && loadingKeys.isEmpty && failed.isEmpty && review.boards.allSatisfy { preview($0) != nil }
    }
    var obscured: Bool { grid || design || conflict || asking || pinSheet }
    var draftNumber: Int { (pins.map(\.number).max() ?? 0) + 1 }
    func width(_ board: V2DesignReview.Board) -> Int { widths[board.file] ?? board.defaultWidth }
    func key(_ board: V2DesignReview.Board) -> String { "\(board.file)@\(width(board))@\(displayScale)" }
    func preview(_ board: V2DesignReview.Board) -> Preview? { previews[key(board)] }

    func load(client: V2Client, item: InboxItem, scale: Double = 1) async {
        displayScale = min(3, max(1, scale))
        guard let project = item.projectId ?? V2DesignReview.project(of: item.id) else { loading = false; return }
        loading = true
        do {
            let result = try await client.designReview(project: project, item: item.id)
            try Task.checkCancellation()
            review = result
            conflict = result.stale == true
            for board in V2ReviewModel.canvasBoards(result) {
                try Task.checkCancellation()
                await loadPreview(client: client, board: board)
            }
        } catch { if !Task.isCancelled { self.error = coordinatorErrorDescription(error) } }
        loading = false
    }
    func loadPreview(client: V2Client, board: V2DesignReview.Board) async {
        guard let review else { return }
        let key = key(board), width = width(board)
        guard previews[key] == nil, !loadingKeys.contains(key) else { return }
        loadingKeys.insert(key)
        defer { loadingKeys.remove(key) }
        do {
            let metadata = try await client.reviewPreview(project: project, item: review.item.id, board: board.file, width: width, scale: displayScale)
            var before: UIImage?, after: UIImage?
            if let url = metadata.before { before = UIImage(data: try await client.reviewImage(url)); guard before != nil else { throw ClientError.invalidResponse } }
            if let url = metadata.after { after = UIImage(data: try await client.reviewImage(url)); guard after != nil else { throw ClientError.invalidResponse } }
            guard before != nil || after != nil else { throw ClientError.invalidResponse }
            try Task.checkCancellation()
            previews[key] = Preview(metadata: metadata, before: before, after: after)
            failed.remove(key)
        } catch { if !Task.isCancelled { failed.insert(key); self.error = coordinatorErrorDescription(error) } }
    }
    func markSeen(client: V2Client, file: String) async {
        guard let review, let index = review.boards.firstIndex(where: { $0.file == file }), review.boards[index].seen != true else { return }
        do {
            try await client.reviewSeen(project: project, item: review.item.id, board: file, revision: review.after)
            self.review?.boards[index].seen = true
        } catch { if !Task.isCancelled { self.error = coordinatorErrorDescription(error) } }
    }
    func drop(board: String, width: Int, revision: String, point: CGPoint, noteId: String? = nil) {
        guard let review, review.item.state == .waiting else { return }
        draft = .init(item: review.item.id, board: board, width: width, revision: revision, x: point.x, y: point.y, noteId: noteId)
        editing = nil; sheetText = ""; pinTool = false; pinSheet = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
    func edit(_ pin: V2ReviewPin) { editing = pin; draft = nil; sheetText = pin.text; pinSheet = true }
    func savePin(client: V2Client, remove: Bool = false, reopen: Bool = false) async {
        guard let review, review.item.state == .waiting, !saving else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            let pins: [V2ReviewPin]
            if let editing {
                if remove { pins = try await client.deleteReviewPin(project: project, item: review.item.id, id: editing.id) }
                else { pins = try await client.editReviewPin(project: project, item: review.item.id, id: editing.id, text: sheetText.trimmingCharacters(in: .whitespacesAndNewlines), resolved: reopen ? false : nil) }
            } else if var draft {
                draft.text = sheetText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !draft.text.isEmpty else { return }
                pins = try await client.addReviewPin(project: project, draft: draft)
            } else { return }
            self.review?.pins = pins; pinSheet = false; draft = nil; editing = nil
        } catch { self.error = coordinatorErrorDescription(error) }
    }
    func finishReview() { page = .decide }

    func answer(client: V2Client, action: String, note: String? = nil) async -> String? {
        guard decisionsReady, (page == .decide || action == "update"), let review else { return nil }
        checking = true; error = nil
        defer { checking = false }
        do {
            let fresh = try await client.designReview(project: project, item: review.item.id)
            // The server repeats this check atomically in the answer transaction.
            guard fresh.after == review.after else { throw ClientError.response(409, "This design changed. Open the review again.") }
            self.review = fresh
            if fresh.stale == true && action != "update" { conflict = true; return nil }
            let result = try await client.answer(fresh.item.id, action: action, note: note)
            self.review?.item = result.item
            let outcome: String
            switch result.item.answer?.actionId {
            case "approve": outcome = "Design approved"
            case "changes": outcome = "Changes requested"
            case "update": outcome = "Design update requested"
            default: outcome = V2Labels.outcome(result.item)
            }
            return result.alreadyAnswered ? "Already answered: \(outcome.lowercased())." : "\(outcome)."
        } catch {
            self.error = coordinatorErrorDescription(error)
            if let fresh = try? await client.designReview(project: project, item: review.item.id) {
                self.review = fresh; conflict = fresh.stale == true
            }
            return nil
        }
    }
}
#endif
