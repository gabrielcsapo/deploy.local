import SwiftUI
import DeployCore

struct ProviderUsageFooter: View {
    let worker: Worker?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Text("Usage")
                Spacer(minLength: 0)
                Text(worker?.name ?? "Computer").lineLimit(1).truncationMode(.middle)
            }.font(.system(.caption)).foregroundStyle(.secondary)
            if let providers = worker?.providers, !providers.isEmpty {
                ForEach(providers) { provider in
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        ProviderUsageRow(provider: provider, online: worker?.status == "online", observedAt: context.date.timeIntervalSince1970)
                    }
                }
            } else {
                Text("Usage unavailable on this computer").font(.caption).foregroundStyle(.secondary)
            }
        }.accessibilityElement(children: .contain).accessibilityLabel("Provider usage")
    }
}

private struct ProviderUsageRow: View {
    let provider: ProviderUsage
    let online: Bool
    let observedAt: Double
    @State private var expanded = false
    private var stale: Bool { !online || observedAt - (provider.checkedAt ?? 0) > 120 || provider.windows.contains { ($0.resetsAt ?? .infinity) <= observedAt } }
    private var highest: Double { provider.windows.map(\.usedPercent).max() ?? 0 }
    private var status: String {
        switch provider.status {
        case "loading": return "Checking…"
        case "signed-out": return "Sign in required"
        case "signed-in": return provider.windows.isEmpty ? "Usage unavailable" : "\(Int(highest.rounded()))% used\(stale ? " · stale" : "")"
        default: return "Unavailable"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button { expanded.toggle() } label: {
                VStack(spacing: 7) {
                    HStack(spacing: 6) {
                        Text(provider.name).font(.system(.footnote, weight: .medium))
                        Spacer(minLength: 0)
                        Text(status).font(.system(.caption)).foregroundStyle(.secondary).monospacedDigit()
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(.caption)).foregroundStyle(.secondary)
                    }
                    if !provider.windows.isEmpty {
                        ProgressView(value: highest, total: 100).tint(.secondary)
                            .accessibilityLabel("\(provider.name) most used allowance")
                    }
                }.padding(.vertical, 4).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("\(provider.name), \(status), \(expanded ? "hide" : "show") usage details")
            if expanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 7) {
                        if provider.status == "signed-in" {
                            Text(provider.plan.map { "\($0.capitalized) account" } ?? "Signed in")
                        }
                        ForEach(provider.windows) { window in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(window.label)
                                    Spacer()
                                    Text("\(Int(window.usedPercent.rounded()))% used").monospacedDigit()
                                }.foregroundStyle(.primary)
                                Text("\(Int((100 - window.usedPercent).rounded()))% remaining")
                                if let reset = window.resetsAt {
                                    Text("\(reset <= Date().timeIntervalSince1970 ? "Reset due" : "Resets") \(Date(timeIntervalSince1970: reset).formatted(date: .abbreviated, time: .shortened))")
                                } else { Text("Reset time unavailable") }
                            }
                        }
                        if provider.status == "signed-out" {
                            Text("Sign in with \(provider.id == "codex" ? "codex login" : "claude auth login") on this computer.")
                        } else if provider.status == "signed-in" && provider.windows.isEmpty {
                            Text("The provider has not reported account limits through this connection.")
                        } else if provider.status == "unavailable" {
                            Text("Could not read the provider account. Check its CLI on this computer.")
                        }
                        if let checked = provider.checkedAt {
                            Text("\(stale ? "Last checked" : "Updated") \(Date(timeIntervalSince1970: checked).formatted(date: .omitted, time: .shortened)). \(stale ? "Waiting for fresh usage." : "Refreshes every minute.")")
                        }
                        if !online { Text("Computer offline") }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 170).font(.system(.caption)).foregroundStyle(.secondary)
            }
        }
    }
}
