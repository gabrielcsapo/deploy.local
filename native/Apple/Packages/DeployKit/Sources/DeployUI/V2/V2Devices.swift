#if os(iOS)
import SwiftUI
import DeployCore

struct V2DevicesView: View {
    let store: V2Store
    @State private var devices: [V2PairedDeviceSummary] = []
    @State private var selected: V2PairedDeviceSummary?
    @State private var error: String?
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                ForEach(devices) { device in
                    HStack { VStack(alignment: .leading) { Text(device.name); Text("Added \(V2Labels.shortDate(device.createdAt))").font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("Remove", role: .destructive) { selected = device }.disabled(busy) }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle("Paired devices").toolbar { Button("Done") { dismiss() } }.task { await load() }
                .confirmationDialog("Remove \(selected?.name ?? "device")?", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
                    Button("Remove device", role: .destructive) { guard let device = selected else { return }; busy = true; Task { do { try await store.client.revokeDevice(device.id); await load() } catch { self.error = error.localizedDescription }; busy = false } }
                } message: { Text("Signs this device out and stops its push notifications.") }
        }
    }
    private func load() async { do { devices = try await store.client.pairedDevices(); error = nil } catch { self.error = error.localizedDescription } }
}
#endif
