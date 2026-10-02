// shared/src/projectColors.ts → ios/HarnessKit Logic/ProjectColors.swift (Themes/ProjectColorsTests.swift).

import { isProjectColorId, normalizeProjectColor, projectColorHex, projectColorName } from "../../src/projectColors";
import { cases } from "../case";

// Inputs are `unknown` in TS (stored JSON), so they include non-strings. JSON has no undefined, so
// "absent" inputs are written as null.
const UNKNOWN_INPUTS: Record<string, unknown> = {
  "preset id": "red",
  "last preset": "pink",
  "upper-case preset": "RED",
  "padded preset": " teal ",
  "unknown name": "magenta",
  "empty string": "",
  "whitespace only": "   ",
  "nbsp padded preset": " blue ",
  "hex6 lower": "#e5484d",
  "hex6 upper": "#E5484D",
  "hex6 padded": "  #AaBbCc\n",
  "hex3 expands": "#ABC",
  "hex4 rejected": "#abcd",
  "hex8 rejected": "#aabbccdd",
  "hex7 rejected": "#abcdef0",
  "no hash rejected": "abcdef",
  "non-hex digit rejected": "#abcdeg",
  "rgb() rejected": "rgb(1, 2, 3)",
  "null": null,
  "number": 42,
  "boolean": true,
  "object": { id: "red" },
  "array": ["red"],
};

export const isProjectColorIdCases = cases(isProjectColorId, UNKNOWN_INPUTS);

/** undefined (refused) and null (none) both become JSON null, so the refusal is spelled out. */
export const normalizeProjectColorCases = cases((v: unknown) => {
  const n = normalizeProjectColor(v);
  return n === undefined ? { invalid: true } : { value: n };
}, UNKNOWN_INPUTS);

const STORED_INPUTS: Record<string, string | null> = {
  none: null,
  "empty string": "",
  red: "red",
  orange: "orange",
  yellow: "yellow",
  lime: "lime",
  green: "green",
  teal: "teal",
  cyan: "cyan",
  blue: "blue",
  indigo: "indigo",
  purple: "purple",
  pink: "pink",
  "upper-case preset": "PURPLE",
  "custom hex": "#123456",
  "custom hex upper": "#ABCDEF",
  "custom hex3": "#f0a",
  "custom hex equal to a preset swatch stays custom": "#e5484d",
  "unusable value": "bogus",
  "hex4 unusable": "#abcd",
};

export const projectColorHexCases = cases(projectColorHex, STORED_INPUTS);
export const projectColorNameCases = cases(projectColorName, STORED_INPUTS);
