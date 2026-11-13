export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
