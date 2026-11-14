// Feature bootstrap installs a read-time data conversion; persistence and HTTP stay generic.
let convert: (value: any) => any = (value) => value;
export function setStoredValueReader(reader: (value: any) => any) {
  convert = reader;
}
export function readStoredValue<T>(value: T): T {
  return convert(value);
}
