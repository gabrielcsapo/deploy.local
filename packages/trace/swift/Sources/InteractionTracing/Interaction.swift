import Foundation

private func newID() -> String {
  UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
}
private func uptimeMilliseconds() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
public struct InteractionEvent: Codable, Sendable {
  public struct Span: Codable, Sendable {
    let spanId, parentSpanId, name: String
    let startMs, durationMs: Double
    let statusCode: Int?
    let failed: Bool
  }
  public let traceId, spanId, name, outcome, milestone, platform: String
  public let startedAtUnixMs: Double?
  public let durationMs: Double
  public let spans: [Span]
}
@MainActor public final class InteractionTracer {
  private let key: String
  private let send: @MainActor ([InteractionEvent]) async throws -> Bool
  private let batched: Bool
  private var timer: Task<Void, Never>?
  private var pending: [InteractionEvent]
  private var closed = false, sending = false
  public convenience init(
    scope: String, send: @escaping @MainActor (InteractionEvent) async throws -> Bool
  ) {
    self.init(scope: scope, batched: false) { events in try await send(events[0]) }
  }
  public convenience init(
    batchingScope scope: String,
    sendBatch: @escaping @MainActor ([InteractionEvent]) async throws -> Bool
  ) {
    self.init(scope: scope, batched: true, send: sendBatch)
  }
  private init(
    scope: String, batched: Bool,
    send: @escaping @MainActor ([InteractionEvent]) async throws -> Bool
  ) {
    self.batched = batched
    key = "trace.pending." + scope
    self.send = send
    pending =
      (UserDefaults.standard.data(forKey: key).flatMap {
        try? JSONDecoder().decode([InteractionEvent].self, from: $0)
      }) ?? []
  }
  public func start(_ name: String) -> Interaction { Interaction(name: name, tracer: self) }
  public func close() {
    closed = true
    timer?.cancel()
    timer = nil
    pending = []
    persist()
  }
  private func persist() {
    if pending.isEmpty {
      UserDefaults.standard.removeObject(forKey: key)
    } else if let data = try? JSONEncoder().encode(pending) {
      UserDefaults.standard.set(data, forKey: key)
    }
  }
  fileprivate func enqueue(_ event: InteractionEvent) {
    guard !closed else { return }
    pending.append(event)
    if pending.count > 16 { pending.removeFirst() }
    persist()
    if timer == nil {
      timer = Task { [weak self] in
        if self?.batched == true { try? await Task.sleep(for: .milliseconds(500)) }
        guard !Task.isCancelled else { return }
        self?.timer = nil
        await self?.flush()
      }
    }
  }
  public func flush() async {
    guard !sending, !closed else { return }
    sending = true
    defer { sending = false }
    while !closed, !pending.isEmpty {
      let batch = Array(pending.prefix(batched ? 16 : 1))
      guard (try? await send(batch)) == true else { return }
      let ids = Set(batch.map(\.traceId))
      pending.removeAll { ids.contains($0.traceId) }
      persist()
    }
  }
}
public enum InteractionScope {
  @TaskLocal public static var current: Interaction?
}
@MainActor public final class Interaction {
  public let traceId = newID()
  private let startedAtUnixMs = Date().timeIntervalSince1970 * 1000
  private let root = String(newID().suffix(16)), start = uptimeMilliseconds(), name: String
  private weak var tracer: InteractionTracer?
  private var spans: [InteractionEvent.Span] = [], count = 0, ended = false
  fileprivate init(name: String, tracer: InteractionTracer) {
    self.name = name
    self.tracer = tracer
  }
  public func measure<T: Sendable>(
    _ name: String, statusCode: (T) -> Int? = { _ in nil },
    failedWhen: (T) -> Bool = { _ in false },
    _ work: @Sendable (String) async throws -> T
  )
    async rethrows -> T
  {
    guard !ended, count < 16 else { return try await work("00-" + traceId + "-" + root + "-01") }
    count += 1
    let child = String(newID().suffix(16))
    let at = uptimeMilliseconds()
    var code: Int?
    var failed = true
    defer {
      if !ended {
        spans.append(
          .init(
            spanId: child, parentSpanId: root, name: name, startMs: at - start,
            durationMs: uptimeMilliseconds() - at, statusCode: code, failed: failed))
      }
    }
    let result = try await work("00-" + traceId + "-" + child + "-01")
    code = statusCode(result)
    failed = failedWhen(result)
    return result
  }
  public func finish(_ milestone: String, outcome: String = "ok") {
    guard !ended else { return }
    ended = true
    let event = InteractionEvent(
      traceId: traceId, spanId: root, name: name, outcome: outcome, milestone: milestone,
      platform: "apple", startedAtUnixMs: startedAtUnixMs, durationMs: uptimeMilliseconds() - start,
      spans: spans)
    Task { [weak tracer] in tracer?.enqueue(event) }
  }
  public nonisolated static func tracedData(
    _ request: URLRequest, session: URLSession, origin: URL,
    tracer: InteractionTracer?, operation: String?
  ) async throws -> (Data, URLResponse) {
    guard let tracer, let operation, InteractionScope.current == nil,
      request.value(forHTTPHeaderField: "traceparent") == nil,
      let url = request.url, url.scheme == origin.scheme, url.host == origin.host,
      url.port == origin.port
    else { return try await data(request, session: session, origin: origin) }
    let interaction = await tracer.start(operation)
    do {
      let result = try await InteractionScope.$current.withValue(interaction) {
        try await data(request, session: session, origin: origin)
      }
      let status = (result.1 as? HTTPURLResponse)?.statusCode ?? 0
      await interaction.finish("response.received", outcome: status >= 400 ? "error" : "ok")
      return result
    } catch {
      let cancelled = Task.isCancelled || (error as? URLError)?.code == .cancelled
      await interaction.finish(
        cancelled ? "request.cancelled" : "request.failed",
        outcome: cancelled ? "cancelled" : "error")
      throw error
    }
  }
  public nonisolated static func data(_ request: URLRequest, session: URLSession, origin: URL)
    async throws -> (Data, URLResponse)
  {
    guard request.value(forHTTPHeaderField: "traceparent") == nil,
      let active = InteractionScope.current, !(await active.ended), let url = request.url,
      url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port
    else { return try await session.data(for: request) }
    return try await active.measure(
      "http.fetch", statusCode: { ($0.1 as? HTTPURLResponse)?.statusCode },
      failedWhen: { (result: (Data, URLResponse)) in
        (result.1 as? HTTPURLResponse).map { $0.statusCode >= 400 } ?? false
      }
    ) { parent in
      var copy = request
      copy.setValue(parent, forHTTPHeaderField: "traceparent")
      return try await session.data(for: copy)
    }
  }
}

// The wire format is shared with any OTLP/HTTP JSON receiver.
public enum TraceExport {
  public static func operation(_ request: URLRequest, prefix: String, families: Set<String>)
    -> String?
  {
    guard let path = request.url?.path, path.hasPrefix(prefix),
      let first = path.dropFirst(prefix.count).split(separator: "/").first
    else { return nil }
    let family = String(first)
    guard families.contains(family) else { return nil }
    let method = (request.httpMethod ?? "GET").lowercased()
    return "http."
      + (["get", "post", "put", "patch", "head", "delete", "options"].contains(method)
        ? method : "other") + "." + family
  }
  public static func body(_ events: [InteractionEvent], service: String) throws -> Data {
    var spans = [[String: Any]]()
    for event in events {
      guard let start = event.startedAtUnixMs else { continue }
      let epoch = Int64((start * 1000).rounded()) * 1000
      func at(_ ms: Double) -> String { String(epoch + Int64((ms * 1_000_000).rounded())) }
      spans.append([
        "traceId": event.traceId, "spanId": event.spanId, "name": event.name, "kind": 1,
        "startTimeUnixNano": at(0), "endTimeUnixNano": at(event.durationMs),
        "status": ["code": event.outcome == "error" ? 2 : 0],
        "events": [["name": event.milestone, "timeUnixNano": at(event.durationMs)]],
      ])
      for span in event.spans {
        spans.append([
          "traceId": event.traceId, "spanId": span.spanId, "parentSpanId": span.parentSpanId,
          "name": span.name, "kind": span.name == "http.fetch" ? 3 : 1,
          "startTimeUnixNano": at(span.startMs),
          "endTimeUnixNano": at(span.startMs + span.durationMs),
          "attributes": span.statusCode.map {
            [["key": "http.response.status_code", "value": ["intValue": String($0)]]]
          } ?? [], "status": ["code": span.failed ? 2 : 0],
        ])
      }
    }
    return try JSONSerialization.data(withJSONObject: [
      "resourceSpans": [
        [
          "resource": ["attributes": [["key": "service.name", "value": ["stringValue": service]]]],
          "scopeSpans": [["scope": ["name": "interaction-tracing"], "spans": spans]],
        ]
      ]
    ])
  }
}
