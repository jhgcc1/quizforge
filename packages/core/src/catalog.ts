import type { CatalogEntry } from "./schemas.js";

/**
 * The documents offered in the "Document" dropdown. Real READMEs show the generator on real input; the `test`
 * documents (evals/fixtures, served from this repository) each exercise one behaviour on purpose.
 * Every URL must be on the API's host allow-list (a test asserts it), and every `test` file must exist.
 */
const REPO_RAW = "https://raw.githubusercontent.com/jhgcc1/quizforge/main/evals/fixtures";

export const SAMPLE_CATALOG: readonly CatalogEntry[] = [
  { id: "pipecat", kind: "readme", title: "Pipecat", description: "Python framework for real-time voice and multimodal agents", url: "https://raw.githubusercontent.com/pipecat-ai/pipecat/main/README.md", language: "en", size: "long", tests: "Long document: split by section (map-reduce)" },
  { id: "mastra", kind: "readme", title: "Mastra", description: "TypeScript framework for AI applications and agents", url: "https://raw.githubusercontent.com/mastra-ai/mastra/main/README.md", language: "en", size: "medium", tests: "Medium document: one prompt, then a review pass" },
  { id: "fastify", kind: "readme", title: "Fastify", description: "Fast and low-overhead Node.js web framework", url: "https://raw.githubusercontent.com/fastify/fastify/main/README.md", language: "en", size: "long", tests: "Long document with many links and badges" },
  { id: "ripgrep", kind: "readme", title: "ripgrep", description: "Line-oriented search tool written in Rust", url: "https://raw.githubusercontent.com/BurntSushi/ripgrep/master/README.md", language: "en", size: "long", tests: "Long document with tables and command examples" },
  { id: "hono", kind: "readme", title: "Hono", description: "Small web framework for edge runtimes", url: "https://raw.githubusercontent.com/honojs/hono/main/README.md", language: "en", size: "short", tests: "Short real README" },
  { id: "requests", kind: "readme", title: "Requests", description: "Python HTTP library", url: "https://raw.githubusercontent.com/psf/requests/main/README.md", language: "en", size: "short", tests: "Short real README" },
  { id: "zephyr-cache", kind: "test", title: "Zephyr Cache", description: "Test document: in-memory cache with eviction, snapshots and replication", url: `${REPO_RAW}/short-doc.md`, language: "en", size: "short", tests: "Clean short document with many precise facts" },
  { id: "quartz-queue", kind: "test", title: "Quartz Queue", description: "Test document: message queue with several valid answers per fact", url: `${REPO_RAW}/multi-answer.md`, language: "en", size: "short", tests: "Questions where more than one option is correct" },
  { id: "nimbus-cli", kind: "test", title: "Nimbus CLI", description: "Test document: command line tool with code blocks and a table", url: `${REPO_RAW}/code-heavy.md`, language: "en", size: "short", tests: "Code blocks and tables (quotes must match visible text)" },
  { id: "aurora", kind: "test", title: "Biblioteca Aurora", description: "Test document in Portuguese", url: `${REPO_RAW}/portuguese.md`, language: "pt", size: "short", tests: "Questions must be written in Portuguese" },
  { id: "brisa", kind: "test", title: "Brisa Notebook", description: "Test document in Spanish", url: `${REPO_RAW}/spanish.md`, language: "es", size: "short", tests: "Questions must be written in Spanish" },
  { id: "orbit-injection", kind: "test", title: "Orbit Scheduler (prompt injection)", description: "Test document that tries to hijack the AI with hidden instructions", url: `${REPO_RAW}/injection.md`, language: "en", size: "short", tests: "The quiz must ignore the injected instructions" },
  { id: "tiny-clock", kind: "test", title: "Tiny Clock (very short)", description: "Test document with barely enough content for a quiz", url: `${REPO_RAW}/minimal.md`, language: "en", size: "short", tests: "Edge case: almost nothing to ask about" },
];
