// Native select labels (mobile/src/lib/selectOptions.ts) for HarnessKit's State/SelectOptions.swift.
import { selectedLabel, type SelectOption } from "../../../mobile/src/lib/selectOptions";
import { cases } from "../case";

const opts: SelectOption[] = [
  { value: "", label: "Default" },
  { value: "a", label: "Alpha", subtitle: "The first" },
  { value: "b", label: "Beta", disabled: true },
  { value: "a", label: "Alpha again" },
];

type In = { options: SelectOption[]; value: string; fallback: string };

export const selectedLabelCases = cases(({ options, value, fallback }: In) => selectedLabel(options, value, fallback), {
  "empty value is a real option": { options: opts, value: "", fallback: "Choose…" },
  "unlisted value falls back": { options: opts, value: "gone", fallback: "gone-driver" },
  "first match wins": { options: opts, value: "a", fallback: "x" },
  "disabled options still label": { options: opts, value: "b", fallback: "x" },
  "no options": { options: [], value: "", fallback: "Nothing" },
  "empty label is kept": { options: [{ value: "z", label: "" }], value: "z", fallback: "fallback" },
  "value match is exact (case)": { options: opts, value: "A", fallback: "miss" },
});
