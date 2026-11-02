import type { CompileContext, Extension, Token } from "mdast-util-from-markdown";

// Markdown reads a backslash before punctuation as an escape, so a link to
// C:\Users\me\.openmausbot\report.md or \\nas\share\.openmausbot\report.md
// would lose the separator before ".openmausbot". In a link, image or
// definition destination that starts with a drive letter or UNC prefix, such a
// backslash stays a separator; "\\" and the delimiters "\(", "\)", "\<" and "\>"
// still escape. The server and the client both parse with this extension, so
// the file authorized is the file rendered.

const destinations = new WeakSet<object>();
const WINDOWS_DEST = /^(?:[A-Za-z]:(?:[\\/]|$)|\\)/;
const STILL_ESCAPES = new Set(["\\", "(", ")", "<", ">"]);

function enterDestination(this: CompileContext): undefined {
  this.buffer();
  destinations.add(this.stack[this.stack.length - 1]!);
}

function exitCharacterEscapeValue(this: CompileContext, token: Token): undefined {
  // The text node `characterEscape` opened, as mdast's own data handler pops it.
  const tail = this.stack.pop() as unknown as { value: string; position: { end: unknown } };
  const value = this.sliceSerialize(token);
  const separator = destinations.has(this.stack[this.stack.length - 1]!)
    && WINDOWS_DEST.test(tail.value)
    && !STILL_ESCAPES.has(value);
  tail.value += separator ? `\\${value}` : value;
  tail.position.end = { line: token.end.line, column: token.end.column, offset: token.end.offset };
}

export const windowsPathDestinations: Extension = {
  enter: {
    resourceDestinationString: enterDestination,
    definitionDestinationString: enterDestination,
  },
  exit: {
    characterEscapeValue: exitCharacterEscapeValue,
  },
};
