// Feature bootstrap installs a read-time data conversion; persistence and HTTP stay generic.
// Conversion works on stored JSON text where it can: walking and rebuilding every value of every
// record on each read took about 40% of the coordinator's CPU when every read did it.
let convertValue: (value: any) => any = (value) => value;
let convertText: (text: string) => string = (text) => text;
export function setStoredValueReader(reader: (value: any) => any) {
  convertValue = reader;
}
export function setStoredTextReader(reader: (text: string) => string) {
  convertText = reader;
}
export function readStoredValue<T>(value: T): T {
  return convertValue(value);
}
export function readStoredText(text: string): string {
  return convertText(text);
}
/** Parses one stored JSON document, converting old stored links in its text first. */
export function readStoredJson(text: string): any {
  return JSON.parse(convertText(text));
}
