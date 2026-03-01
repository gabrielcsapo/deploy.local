import { getRequest } from "react-flight-router/server";

export default function RequestInfo() {
  const request = getRequest();

  const headers: [string, string][] = [];
  if (request) {
    request.headers.forEach((value, key) => {
      headers.push([key, value]);
    });
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-4">Request Info</h1>
      <p className="text-gray-600 mb-4">
        This page demonstrates <code>getRequest()</code> in a server component.
      </p>

      {request ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold mb-2">Request Details</h2>
            <dl className="bg-gray-100 rounded p-4 space-y-1">
              <div className="flex gap-2">
                <dt className="font-medium">Method:</dt>
                <dd data-testid="request-method">{request.method}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium">URL:</dt>
                <dd data-testid="request-url" className="break-all">
                  {request.url}
                </dd>
              </div>
            </dl>
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-2">Headers</h2>
            <table className="w-full bg-gray-100 rounded overflow-hidden">
              <thead>
                <tr className="bg-gray-200">
                  <th className="text-left px-4 py-2 font-medium">Header</th>
                  <th className="text-left px-4 py-2 font-medium">Value</th>
                </tr>
              </thead>
              <tbody data-testid="headers-table">
                {headers.map(([key, value]) => (
                  <tr key={key} className="border-t border-gray-200">
                    <td className="px-4 py-2 font-mono text-sm">{key}</td>
                    <td className="px-4 py-2 font-mono text-sm break-all">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="text-red-600" data-testid="no-request">
          No request context available
        </p>
      )}
    </div>
  );
}
