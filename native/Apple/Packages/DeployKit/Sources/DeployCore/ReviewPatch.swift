import Foundation

public struct ReviewPatchLine: Equatable, Sendable {
    public enum Kind: Sendable { case context, addition, deletion, hunk, metadata }
    public let text: String
    public let oldNumber: Int?
    public let newNumber: Int?
    public let kind: Kind
}

public struct ReviewFilePatch: Identifiable, Equatable, Sendable {
    public var id: String { path }
    public let path: String
    public let lines: [ReviewPatchLine]
}

/// Present the server's actual unified diff, preserving binary and non-text metadata.
public func reviewFilePatches(_ patch: String, files: [ChangedFile]) -> [ReviewFilePatch] {
    var chunks: [[String]] = []
    for line in patch.components(separatedBy: "\n") {
        if line.hasPrefix("diff --git ") { chunks.append([line]) }
        else if !chunks.isEmpty { chunks[chunks.count - 1].append(line) }
        else if !line.isEmpty { chunks.append([line]) }
    }
    var result: [ReviewFilePatch] = []
    for (index, chunk) in chunks.enumerated() {
        let names = chunk.prefix { !$0.hasPrefix("@@ ") }.filter { $0.hasPrefix("+++ ") || $0.hasPrefix("--- ") }
        let known = files.first { file in
            let diffHeader = chunk.first ?? ""
            let encoder = JSONEncoder(); encoder.outputFormatting = .withoutEscapingSlashes
            let quotedTarget = (try? String(data: encoder.encode("b/" + file.path), encoding: .utf8)) ?? ""
            return diffHeader.hasSuffix(" b/" + file.path) || (!quotedTarget.isEmpty && diffHeader.hasSuffix(" " + quotedTarget)) || names.contains { line in
                let name = String(line.dropFirst(4))
                let decoded = (try? JSONDecoder().decode(String.self, from: Data(name.utf8))) ?? name
                return decoded == "a/" + file.path || decoded == "b/" + file.path
            }
        }?.path
        let headerPath = names.first(where: { $0.hasPrefix("+++ ") && !$0.contains("/dev/null") })
            ?? names.first(where: { !$0.contains("/dev/null") })
        let raw = headerPath.map { String($0.dropFirst(4)) }
        let decoded = raw.map { (try? JSONDecoder().decode(String.self, from: Data($0.utf8))) ?? $0 }
        let fallback = decoded.map { $0.hasPrefix("a/") || $0.hasPrefix("b/") ? String($0.dropFirst(2)) : $0 }
        let path = known ?? fallback ?? (files.count == 1 ? files[0].path : "Changes \(index + 1)")
        var old = 0, new = 0, inHunk = false
        let lines = chunk.compactMap { line -> ReviewPatchLine? in
            if !inHunk && (line.hasPrefix("diff --git ") || line.hasPrefix("index ") || line.hasPrefix("--- ") || line.hasPrefix("+++ ")) { return nil }
            if line.hasPrefix("@@ ") {
                let parts = line.split(separator: " ")
                if parts.count >= 3,
                   let oldPart = parts[1].dropFirst().split(separator: ",").first,
                   let newPart = parts[2].dropFirst().split(separator: ",").first,
                   let oldStart = Int(oldPart), let newStart = Int(newPart) {
                    old = oldStart; new = newStart; inHunk = true
                }
                return ReviewPatchLine(text: line, oldNumber: nil, newNumber: nil, kind: .hunk)
            }
            guard inHunk else { return ReviewPatchLine(text: line, oldNumber: nil, newNumber: nil, kind: .metadata) }
            if line.hasPrefix("+") {
                defer { new += 1 }
                return ReviewPatchLine(text: line, oldNumber: nil, newNumber: new, kind: .addition)
            }
            if line.hasPrefix("-") {
                defer { old += 1 }
                return ReviewPatchLine(text: line, oldNumber: old, newNumber: nil, kind: .deletion)
            }
            if line.hasPrefix(" ") {
                defer { old += 1; new += 1 }
                return ReviewPatchLine(text: line, oldNumber: old, newNumber: new, kind: .context)
            }
            return ReviewPatchLine(text: line, oldNumber: nil, newNumber: nil, kind: .metadata)
        }
        result.append(ReviewFilePatch(path: path, lines: lines))
    }
    for file in files where !result.contains(where: { $0.path == file.path }) {
        result.append(ReviewFilePatch(path: file.path, lines: []))
    }
    return result
}
