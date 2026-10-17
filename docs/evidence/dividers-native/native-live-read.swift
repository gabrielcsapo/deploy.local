import Foundation

struct LiveCredential: Decodable { let url: String; let username: String; let token: String }
@main struct NativeLiveRead {
    @MainActor static func main() async throws {
        let credential = try JSONDecoder().decode(LiveCredential.self, from: Data(contentsOf: URL(fileURLWithPath: "/tmp/deploy-native-ser-connection.json")))
        let connection = Connection(origin: "https://deploy.local", username: credential.username, token: credential.token)
        let store = WorkspaceStore(connection: connection)
        await store.start()
        guard store.isConnected, let state = store.state else { throw NSError(domain: "NativeLiveRead", code: 1, userInfo: [NSLocalizedDescriptionKey: store.error ?? "No state"]) }
        let workerId = preferredTaskWorkerId(workers: state.workers, current: "local")
        guard let worker = state.workers.first(where: { $0.id == workerId }), worker.isProviderAvailable("codex") else { throw NSError(domain: "NativeLiveRead", code: 2) }
        await store.select("32b69e88-60a3-401e-87c3-d752dac95eeb")
        await store.loadDiff()
        guard let detail = store.detail, let diff = store.diff, diff.files.count == 3 else { throw NSError(domain: "NativeLiveRead", code: 3, userInfo: [NSLocalizedDescriptionKey: store.error ?? "Missing diff"]) }
        let client = WorkspaceClient(connection: connection)
        let repository: RepositoryInfo = try await client.request("/api/workspace/projects/ace23c97-5a0f-4378-9136-1467a3977762/repository")
        let result: [String: Any] = ["origin": connection.origin, "connected": store.isConnected, "worker": worker.id, "codexAvailable": worker.isProviderAvailable("codex"), "claudeAvailable": worker.isProviderAvailable("claude"), "taskId": detail.task.id, "messages": detail.messages.count, "runs": detail.runs.map { ["id": $0.id, "status": $0.status] }, "diffFiles": diff.files.map(\.path), "jobs": detail.jobs?.map { ["id": $0.id, "status": $0.status, "exitCode": $0.exitCode ?? -1] as [String: Any] } ?? [], "repository": String(describing: repository)]
        store.suspend()
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
}
