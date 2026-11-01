// One POSIX shell argument; paths never become shell substitutions.
export const shellWord = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
