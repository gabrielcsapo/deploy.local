interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  phone: string;
  website: string;
  company: { name: string };
}

export default async function UserProfilePage({
  params = {},
}: {
  params?: Record<string, string>;
}) {
  const userId = params.id;

  const userRes = await fetch(`https://jsonplaceholder.typicode.com/users/${userId}`);
  const user: User = await userRes.json();

  return (
    <div>
      <p data-testid="user-params-id">User ID: {userId}</p>
      <div className="border border-gray-200 rounded-lg p-5 bg-white mb-6">
        <p className="mb-1">
          <span className="font-medium">Email:</span> {user.email}
        </p>
        <p className="mb-1">
          <span className="font-medium">Phone:</span> {user.phone}
        </p>
        <p className="mb-1">
          <span className="font-medium">Website:</span> {user.website}
        </p>
        <p>
          <span className="font-medium">Company:</span> {user.company.name}
        </p>
      </div>
    </div>
  );
}
