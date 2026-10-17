/// Keep an explicit computer selection; replace the obsolete local default when absent.
public func preferredTaskWorkerId(workers: [Worker], current: String) -> String? {
    if workers.contains(where: { $0.id == current }) { return current }
    return workers.first(where: { $0.status == "online" })?.id ?? workers.first?.id
}
