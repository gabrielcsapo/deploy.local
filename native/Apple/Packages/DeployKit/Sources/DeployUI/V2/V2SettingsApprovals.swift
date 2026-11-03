#if os(iOS)
import SwiftUI
import DeployCore

struct V2SettingsApprovals: View {
    @Bindable var store: V2Store
    @State private var approvals: V2Approvals?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("What agents may do").font(.system(size: 17, weight: .semibold))
                Spacer()
                Button("Done") { dismiss() }.frame(minWidth: 44, minHeight: 44)
                    .foregroundStyle(WorkspaceStyle.accent(scheme))
            }.padding(.leading, 20).padding(.trailing, 16).padding(.top, 16)
            Text("Change these in Settings on a computer.")
                .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                .padding(.horizontal, 20).padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if let approvals {
                        ForEach(store.snapshot.agents) { agent in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(agent.name).font(.system(size: 17, weight: .semibold))
                                    .padding(.horizontal, 16).accessibilityAddTraits(.isHeader)
                                V2Group {
                                    ForEach(V2ApprovalAction.allCases, id: \.self) { action in
                                        if action != V2ApprovalAction.allCases.first { Divider() }
                                        HStack(spacing: 8) {
                                            Text(action.label).font(.system(size: 17))
                                            Spacer(minLength: 0)
                                            Text(approvals.mode(agent: agent.id, action: action).label)
                                                .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                                        }.padding(.horizontal, 16).padding(.vertical, 4).frame(minHeight: 32)
                                            .accessibilityElement(children: .combine)
                                    }
                                }
                            }
                        }
                        if store.snapshot.agents.isEmpty {
                            Text("No agents").font(.system(size: 17)).padding(.horizontal, 16)
                        }
                    } else if error == nil {
                        ProgressView().frame(maxWidth: .infinity).padding()
                    }
                    if let error {
                        Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme))
                        Button("Retry") { Task { await load() } }.frame(minHeight: 44)
                    }
                }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
            }.scrollIndicators(.hidden)
        }.background(WorkspaceStyle.canvas(scheme)).foregroundStyle(WorkspaceStyle.text(scheme))
            .presentationDetents([.large]).presentationDragIndicator(.visible)
            .task { await load() }
    }

    private func load() async {
        error = nil
        do { approvals = try await store.client.approvals() }
        catch { self.error = coordinatorErrorDescription(error) }
    }
}
#endif
