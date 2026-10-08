import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Reference } from "./semantic.js";

const root = fileURLToPath(new URL("..", import.meta.url));

export interface ReferenceSet {
  id: string;
  authoredBy: string;
  questions: Reference[];
}

/** Hand-written "expected questions" for a golden document (evals/references/<id>.json). */
export function loadReferences(id: string): ReferenceSet {
  return JSON.parse(readFileSync(`${root}references/${id}.json`, "utf8")) as ReferenceSet;
}
