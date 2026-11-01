// The code of a module as a test reads it for names and numbers: its comments,
// and the insides of its strings, templates and regular expressions, blanked
// to spaces, line breaks and columns kept, so a line of the result is the code
// of the same line of the source. A template's ${...} stays code, at any depth,
// and a template that spans lines is text on every one of them.
// What may come before a regular expression: an operator or an opening
// bracket, or a keyword that takes an expression after it (return /x/.test(a),
// typeof /x/, case /x/:, key in /x/, for (m of /x/g...)). Before a division
// comes a name, a number, a closing bracket, or a property named like one of
// those keywords (totals.in / 2).
const BEFORE_REGEX = "(,=:[!&|?{};+-*%<>~^";
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const WORD = /[\w$]/;

export function codeOnly(text) {
  let out = "",
    last = "",
    // The word the code so far ends with, spaces after it allowed; "" when it
    // ends with anything else. A word after a dot is a property and keeps its
    // dot (".in"), so it is never a keyword.
    word = "",
    index = 0;
  // The ${...} open in templates, innermost last: the braces open in each.
  const depths = [];
  const blank = (end) => {
    out += text.slice(index, end).replace(/[^\n]/g, " ");
    index = end;
  };
  const scan = (end, stop) => {
    while (end < text.length && !stop(end)) end += text[end] === "\\" ? 2 : 1;
    return Math.min(end, text.length);
  };
  while (index < text.length) {
    const char = text[index],
      next = text[index + 1];
    if (char === "/" && next === "/") blank(scan(index, (at) => text[at] === "\n"));
    else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      blank(end === -1 ? text.length : end + 2);
    } else if (
      char === '"' ||
      char === "'" ||
      (char === "/" && (BEFORE_REGEX.includes(last) || KEYWORDS_BEFORE_REGEX.has(word)))
    ) {
      // A string, or a regular expression (a class may hold its slash).
      let inClass = false;
      out += char;
      index++;
      blank(
        scan(index, (at) => {
          if (char === "/" && text[at] === "[") inClass = true;
          else if (char === "/" && text[at] === "]") inClass = false;
          return text[at] === "\n" || (text[at] === char && !inClass);
        }),
      );
      if (text[index] === char) {
        out += char;
        index++;
      }
      last = char;
      word = "";
    } else if (char === "`" || (char === "}" && depths.at(-1) === 0)) {
      // A template's text, from its start or from the end of a ${...} in it.
      if (char === "}") depths.pop();
      out += char;
      index++;
      blank(scan(index, (at) => text[at] === "`" || text.startsWith("${", at)));
      if (text[index] === "`") {
        out += "`";
        index++;
        last = "`";
      } else if (index < text.length) {
        out += "${";
        index += 2;
        depths.push(0);
        last = "{";
      }
      word = "";
    } else {
      if (depths.length && char === "{") depths[depths.length - 1]++;
      else if (depths.length && char === "}") depths[depths.length - 1]--;
      out += char;
      index++;
      if (WORD.test(char))
        word =
          word && WORD.test(text[index - 2] ?? "")
            ? word + char
            : `${last === "." ? "." : ""}${char}`;
      else if (!/\s/.test(char)) word = "";
      if (!/\s/.test(char)) last = char;
    }
  }
  return out;
}
