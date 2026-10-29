import "server-only";
import type { Tx } from "./db";
import type { KnowledgeChunk } from "./agents/logic/support";

const STOPWORDS = new Set(
  "the and for are but not you your yours with this that from have has had was were will would can could should what when where which who whom why how about into over under again then than them they their there here our ours out off all any each few more most other some such only own same too very just does did doing done been being its it's i'm me my myself we us is am an a of to in on at by or as be do if so no".split(" "),
);

/** Split text into ~800 character chunks on paragraph/sentence boundaries. */
export function chunkText(text: string, target = 800, overlap = 120): string[] {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
  };
  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length <= target) {
      current = current ? `${current}\n\n${p}` : p;
      continue;
    }
    push();
    if (p.length <= target) {
      current = (chunks.length ? chunks[chunks.length - 1].slice(-overlap) + " … " : "") + p;
      continue;
    }
    const sentences = p.split(/(?<=[.!?])\s+/);
    current = "";
    for (const s of sentences) {
      if ((current + " " + s).length > target && current) {
        push();
        current = current.slice(-overlap) + " " + s;
      } else {
        current = current ? `${current} ${s}` : s;
      }
    }
  }
  push();
  // Hard-split anything still oversized (e.g. one long unpunctuated paragraph).
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= target * 1.5) out.push(c);
    else for (let i = 0; i < c.length; i += target - overlap) out.push(c.slice(i, i + target));
  }
  return out.slice(0, 500);
}

/** Build an OR full-text query from a free-form question. Returns null if no useful terms. */
export function toOrTsQuery(question: string): string | null {
  const terms = [...new Set(question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((t) => !STOPWORDS.has(t)).slice(0, 12);
  return terms.length ? terms.join(" | ") : null;
}

export async function searchKnowledge(tx: Tx, orgId: string, question: string, limit = 5): Promise<KnowledgeChunk[]> {
  const q = toOrTsQuery(question);
  if (!q) return [];
  return tx.query<KnowledgeChunk>(
    `select c.document_id, d.title, c.chunk_index, c.content, ts_rank(c.tsv, to_tsquery('english', $2))::float8 as rank
       from public.knowledge_chunks c
       join public.knowledge_documents d on d.id = c.document_id and d.organization_id = c.organization_id
      where c.organization_id = $1 and d.approved and d.status = 'ready'
        and c.tsv @@ to_tsquery('english', $2)
      order by rank desc
      limit $3`,
    [orgId, q, limit],
  );
}
