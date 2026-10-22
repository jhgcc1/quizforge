// Policy for SQL migrations (expand/contract): during a rolling deploy the OLD app version keeps running
// against the NEW schema for a while, so a migration must not break it. Destructive statements are
// rejected unless the file carries an explicit, reviewed opt-in:  -- destructive-ok: <reason>
const RULES = [
  { id: "drop-table", re: /\bDROP\s+TABLE\b/i, why: "drops a table the previous app version may still read" },
  { id: "drop-column", re: /\bDROP\s+COLUMN\b/i, why: "drops a column the previous app version may still use" },
  { id: "rename", re: /\bRENAME\s+(?:TO|COLUMN)\b/i, why: "renames break the previous app version; add the new name, backfill, then drop the old in a later release" },
  { id: "alter-type", re: /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, why: "changing a column type rewrites the table and can break readers" },
  { id: "set-not-null", re: /\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/i, why: "SET NOT NULL fails or blocks writes from the previous app version" },
  { id: "truncate", re: /\bTRUNCATE\b/i, why: "deletes data" },
  { id: "drop-schema-or-db", re: /\bDROP\s+(?:SCHEMA|DATABASE)\b/i, why: "deletes data" },
];

const OPT_IN = /--[ \t]*destructive-ok:[ \t]*\S+/i; // same line: a bare marker with no reason does not count

/** Returns the list of violations for one migration file's SQL. drizzle-kit separates statements with `--> statement-breakpoint`. */
export function checkMigrationSql(sql) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("--") || /destructive-ok/i.test(l)).join("\n");
  if (OPT_IN.test(sql)) return [];
  const body = code.split("\n").filter((l) => !/destructive-ok/i.test(l)).join("\n");
  return RULES.filter((r) => r.re.test(body)).map((r) => ({ rule: r.id, why: r.why }));
}
