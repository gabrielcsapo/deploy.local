import Foundation

/// The lists are separate SQLite snapshots. An absent waiting item is authoritative only
/// through the waiting list's position; an answered item may come from a later snapshot.
public struct V2InboxPosition: Codable, Sendable {
    var waiting = 0
    var answered = 0
    var items: [String: Int] = [:]

    mutating func accepts(_ item: InboxItem, cursor: Int, at: String, previous: InboxItem?) -> Bool {
        let boundary = item.state == .waiting ? waiting : item.state == .answered ? answered : min(waiting, answered)
        guard cursor > max(boundary, items[item.id] ?? 0) else { return false }
        if waiting == 0 && answered == 0 && items[item.id] == nil,
           let previous, previous.state != .waiting, item.state == .waiting, item.createdAt <= previous.createdAt { return false }
        if let previous, let answer = previous.answer, item.answer == nil,
           at <= answer.at, item.createdAt <= previous.createdAt { return false }
        items[item.id] = cursor
        return true
    }
}

public struct V2InboxPage: Decodable, Sendable {
    public var items: [InboxItem]
    public var cursor: Int?
}
