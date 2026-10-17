import SwiftUI
import DeployCore

/// A recorded job verifies an immutable checkpoint on its execution computer.
struct CheckpointJobRow: View {
    let job: WorkspaceJob
    var body: some View {
        DisclosureGroup {
            if !job.output.isEmpty {
                ScrollView(.horizontal) {
                    Text(job.output).font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled).padding(10)
                }.background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            }
            if job.truncated { Text("Showing the last 64,000 characters.").font(.caption).foregroundStyle(.secondary) }
            if let error = job.error { Text(error).font(.caption).foregroundStyle(.red) }
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: job.status == "succeeded" ? "checkmark.circle.fill" : job.status == "failed" ? "xmark.circle" : "clock")
                    .foregroundStyle(job.status == "succeeded" ? Color.green : Color.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(job.command).font(.system(size: 12, design: .monospaced)).lineLimit(2)
                    Text("Checkpoint \(job.digest.prefix(12)) · \(job.status.replacingOccurrences(of: "_", with: " "))\(job.exitCode.map { " · Exit \($0)" } ?? "")")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}
