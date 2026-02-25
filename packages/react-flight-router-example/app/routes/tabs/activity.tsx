export default function TabsActivity() {
  const recentItems = [
    { id: 1, action: "Created project", time: "2 hours ago" },
    { id: 2, action: "Updated settings", time: "5 hours ago" },
    { id: 3, action: "Added collaborator", time: "1 day ago" },
  ];

  return (
    <div data-testid="tabs-activity">
      <h2 className="text-xl font-semibold mb-2">Activity</h2>
      <p className="text-gray-600 mb-4">
        This is the activity tab. It is a pure server component with no client interactivity.
      </p>
      <p className="text-sm text-gray-500 mb-4" data-testid="tabs-activity-timestamp">
        Activity rendered at {new Date().toISOString()}
      </p>
      <ul className="space-y-2" data-testid="tabs-activity-list">
        {recentItems.map((item) => (
          <li key={item.id} className="flex justify-between p-3 bg-gray-50 rounded text-sm">
            <span className="text-gray-800">{item.action}</span>
            <span className="text-gray-500">{item.time}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
