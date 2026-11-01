// One role catalogue supplies runtime defaults and forwarder display metadata.
// Keep the existing ROLES and DISPLAY shapes: callers do not see catalogue-only fields.
const CATALOGUE = {
  "gpt-6-1-sol": {
    model: "gpt-6.1-sol",
    effort: "xhigh",
    display: "GPT-6.1-Sol",
    alias: '("6.1 sol")',
  },
  "gpt-6-1-terra": {
    model: "gpt-6.1-terra",
    effort: "xhigh",
    display: "GPT-6.1-Terra",
    alias: '("6.1 terra")',
  },
  "gpt-6-astra": {
    model: "gpt-6-astra",
    effort: "xhigh",
    display: "GPT-6 Astra",
    alias: '("6.0 astra", "astra")',
  },
  "gpt-6-sol": {
    model: "gpt-6-sol",
    effort: "xhigh",
    display: "GPT-6-Sol",
    alias: '("6.0 sol", "6 sol")',
  },
  "gpt-6-luna": {
    model: "gpt-6-luna",
    effort: "xhigh",
    display: "GPT-6-Luna",
    alias: '("6.0 luna", "6 luna")',
  },
  "gpt-5-6-sol": {
    model: "gpt-5.6-sol",
    effort: "xhigh",
    display: "GPT-5.6-Sol",
    alias: '("5.6 sol")',
  },
  "gpt-5-6-terra": {
    model: "gpt-5.6-terra",
    effort: "xhigh",
    display: "GPT-5.6-Terra",
    alias: '("5.6 terra", "terra")',
  },
  "gpt-5-6-luna": {
    model: "gpt-5.6-luna",
    effort: "xhigh",
    display: "GPT-5.6-Luna",
    alias: '("5.6 luna")',
  },
};

export const ROLES = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOGUE).map(([role, { model, effort }]) => [role, { model, effort }]),
  ),
);
export const DISPLAY = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOGUE).map(([role, { display, alias }]) => [
      role,
      { model: display, alias },
    ]),
  ),
);
