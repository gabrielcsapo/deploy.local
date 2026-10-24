/// Bounded navigation over media in the task's transcript order.
public struct MediaNavigation: Equatable, Sendable {
    public let ids: [String]
    public private(set) var index: Int
    public init(ids: [String], initialID: String) {
        self.ids = ids
        self.index = ids.firstIndex(of: initialID) ?? 0
    }
    public var selectedID: String? { ids.indices.contains(index) ? ids[index] : nil }
    public var canGoBack: Bool { index > 0 }
    public var canGoForward: Bool { index + 1 < ids.count }
    public mutating func select(_ index: Int) {
        guard ids.indices.contains(index) else { return }
        self.index = index
    }
    public mutating func step(_ offset: Int) { select(index + offset) }
    public mutating func first() { select(0) }
    public mutating func last() { select(ids.count - 1) }
}
