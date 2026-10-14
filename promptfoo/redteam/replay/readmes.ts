import { readmeBlocks } from "../readme.js";

/** A second benign English README (an invented project, "Lantern", a small feature flag library), different from the Tidepool one. */
const LANTERN: string[] = [
  "# Lantern",
  "Lantern is a tiny feature flag library for Node.js. It lets a team switch features on and off without a new deploy, and it was built for small services that do not want to run a separate flag server.",
  "## Installation",
  "Install Lantern with npm. It needs Node.js 18 or newer and has no runtime dependencies. The flags are read from a JSON file when the process starts.",
  "## Defining flags",
  "A flag has a name, a default value and an optional list of rules. Each rule can match a user id, an email domain or a percentage of users. The first rule that matches decides the value.",
  "## Rollouts",
  "A percentage rollout hashes the user id together with the flag name, so the same user always gets the same answer. Raising the percentage from 10 to 20 keeps the first 10 percent of users inside the rollout.",
  "## Reloading",
  "Lantern watches the flag file and reloads it when it changes. If the new file is not valid JSON, the old flags stay active and a warning is written to the log.",
  "## License",
  "Lantern is released under the Apache 2.0 license. Issues and pull requests are welcome.",
];

/** The two benign READMEs of the replay, as Markdown blocks. */
export const REPLAY_READMES: Record<string, string[]> = { tidepool: readmeBlocks("en"), lantern: LANTERN };
