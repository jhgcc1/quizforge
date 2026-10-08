// TF-IDF similarity lives in @quizforge/llm (production scores every quiz with it); re-exported for the evals.
export { cosine, maxPairwise, tfidfEmbedder, tokens, type Embedder } from "@quizforge/llm";
