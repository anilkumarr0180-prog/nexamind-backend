/**
 * Reusable Document Chunking Service for NexaMind (Step 13)
 *
 * Converts extracted document text into bounded, deterministically indexed chunks
 * to avoid overwhelming the AI prompt context window while preserving semantic
 * boundaries and cross-chunk continuity via controlled overlap.
 */

import { MAX_DOCUMENT_CHUNKS, type IAttachment } from "./attachment.types.js";

/**
 * Standard default maximum characters per chunk (~300 tokens).
 * Bounded sensibly to fit within embedding context windows (e.g. nomic-embed-text)
 * and LLM context budgets.
 */
export const DEFAULT_MAX_CHUNK_SIZE = 1200;
export const DEFAULT_CHUNK_SIZE = DEFAULT_MAX_CHUNK_SIZE;

/**
 * Standard default character overlap between adjacent chunks (~50 tokens).
 * Guarantees cross-boundary semantic context without prompt bloating.
 */
export const DEFAULT_CHUNK_OVERLAP = 200;
export const DEFAULT_OVERLAP = DEFAULT_CHUNK_OVERLAP;

/**
 * Chunking options for configuring bounded size and overlap.
 */
export interface ChunkingOptions {
  maxChunkSize?: number | undefined;
  chunkSize?: number | undefined;
  chunkOverlap?: number | undefined;
  overlap?: number | undefined;
  maxChunks?: number | undefined;
}

/**
 * Deterministic chunk metadata structure.
 */
export interface DocumentChunk {
  attachmentId: string;
  chunkIndex: number;
  text: string;
}

export interface ChunkDocumentTextInput {
  attachmentId: string;
  text: string;
  maxChunkSize?: number | undefined;
  chunkSize?: number | undefined;
  chunkOverlap?: number | undefined;
  overlap?: number | undefined;
  maxChunks?: number | undefined;
}

/**
 * Normalizes document text whitespace:
 * - Unifies CRLF/CR to LF
 * - Trims horizontal space on each line
 * - Collapses repeated horizontal whitespace (tabs/spaces) into single space
 * - Collapses excessive blank lines (3+ newlines into 2)
 * - Trims leading and trailing whitespace
 */
export const cleanDocumentText = (rawText: string): string => {
  if (!rawText || typeof rawText !== "string") {
    return "";
  }

  return rawText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/**
 * Estimates token count using standard character-to-token heuristic (~4 chars/token).
 */
export const estimateTokenCount = (text: string): number => {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
};

/**
 * Chunks extracted document text into bounded, overlapping chunks with deterministic metadata.
 * Preserves paragraph, sentence, and word boundaries where possible.
 */
export function chunkDocumentText(input: ChunkDocumentTextInput): DocumentChunk[];
export function chunkDocumentText(
  attachmentId: string,
  text: string,
  options?: ChunkingOptions,
): DocumentChunk[];
export function chunkDocumentText(
  arg1: string | ChunkDocumentTextInput,
  arg2?: string | ChunkingOptions,
  arg3?: ChunkingOptions,
): DocumentChunk[] {
  let attachmentId: string;
  let rawText: string;
  let options: ChunkingOptions | undefined;

  if (typeof arg1 === "object" && arg1 !== null) {
    attachmentId = String(arg1.attachmentId ?? "");
    rawText = arg1.text;
    options = arg1;
  } else {
    attachmentId = String(arg1 ?? "");
    rawText = typeof arg2 === "string" ? arg2 : "";
    options = arg3;
  }

  // 1. Sanitize and normalize whitespace
  const text = cleanDocumentText(rawText);
  if (!text || text.length === 0) {
    return [];
  }

  // 2. Resolve bounded chunk size and overlap
  const resolvedMaxChunkSize = options?.maxChunkSize ?? options?.chunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const maxChunkSize = Math.max(1, resolvedMaxChunkSize);

  const rawOverlap = options?.chunkOverlap ?? options?.overlap ?? DEFAULT_CHUNK_OVERLAP;
  // Overlap cannot exceed 80% of maxChunkSize to guarantee strict forward progress
  const chunkOverlap = Math.max(0, Math.min(rawOverlap, Math.floor(maxChunkSize * 0.8)));

  const rawMaxChunks = options?.maxChunks ?? MAX_DOCUMENT_CHUNKS;
  const maxChunks = Math.max(1, rawMaxChunks);

  // 3. Small document optimization: entire document fits in 1 chunk
  if (text.length <= maxChunkSize) {
    return [
      {
        attachmentId,
        chunkIndex: 0,
        text,
      },
    ];
  }

  const chunks: DocumentChunk[] = [];
  let start = 0;

  while (start < text.length) {
    // Advance past any leading whitespace at current start position
    while (start < text.length && /\s/.test(text[start]!)) {
      start++;
    }
    if (start >= text.length) break;

    const remaining = text.length - start;
    if (remaining <= maxChunkSize) {
      const chunkText = text.slice(start).trim();
      if (chunkText.length > 0) {
        chunks.push({
          attachmentId,
          chunkIndex: chunks.length,
          text: chunkText,
        });
      }
      break;
    }

    const maxEnd = start + maxChunkSize;
    // We aim for at least 30% progress before cutting to avoid tiny micro-chunks
    const minProgress = start + Math.max(1, Math.floor(maxChunkSize * 0.3));
    const slice = text.slice(start, maxEnd);

    let cutRelative = -1;

    // 1. Paragraph boundary (\n\n)
    const paraIdx = slice.lastIndexOf("\n\n");
    if (paraIdx !== -1 && start + paraIdx >= minProgress) {
      cutRelative = paraIdx;
    }

    // 2. Line break (\n)
    if (cutRelative === -1) {
      const lineIdx = slice.lastIndexOf("\n");
      if (lineIdx !== -1 && start + lineIdx >= minProgress) {
        cutRelative = lineIdx;
      }
    }

    // 3. Sentence boundary (.!? followed by whitespace or end of slice)
    if (cutRelative === -1) {
      const sentenceRegex = /[.!?](\s|$)/g;
      let match: RegExpExecArray | null;
      let lastSentenceIdx = -1;
      while ((match = sentenceRegex.exec(slice)) !== null) {
        if (start + match.index >= minProgress) {
          lastSentenceIdx = match.index + 1; // Include punctuation
        }
      }
      if (lastSentenceIdx !== -1) {
        cutRelative = lastSentenceIdx;
      }
    }

    // 4. Clause boundary (,;: followed by whitespace)
    if (cutRelative === -1) {
      const clauseRegex = /[,;:](\s|$)/g;
      let match: RegExpExecArray | null;
      let lastClauseIdx = -1;
      while ((match = clauseRegex.exec(slice)) !== null) {
        if (start + match.index >= minProgress) {
          lastClauseIdx = match.index + 1;
        }
      }
      if (lastClauseIdx !== -1) {
        cutRelative = lastClauseIdx;
      }
    }

    // 5. Word boundary (whitespace)
    if (cutRelative === -1) {
      const spaceIdx = slice.lastIndexOf(" ");
      if (spaceIdx !== -1 && start + spaceIdx >= minProgress) {
        cutRelative = spaceIdx;
      }
    }

    // 6. Hard cut (oversized unbroken token/paragraph)
    const end = cutRelative !== -1 ? start + cutRelative : maxEnd;
    const chunkText = text.slice(start, end).trim();

    if (chunkText.length > 0) {
      chunks.push({
        attachmentId,
        chunkIndex: chunks.length,
        text: chunkText,
      });
      if (chunks.length >= maxChunks) {
        break;
      }
    }

    if (end >= text.length) break;

    // Determine nextStart with overlap
    if (chunkOverlap <= 0) {
      start = end;
    } else {
      const targetOverlap = Math.min(chunkOverlap, Math.floor((end - start) * 0.6));
      const idealStart = end - targetOverlap;
      const tolerance = Math.max(10, Math.floor(targetOverlap * 0.4));
      const searchLower = Math.max(start + 1, idealStart - tolerance);
      const searchUpper = Math.min(end - 1, idealStart + tolerance);

      let bestBoundary = -1;
      if (searchUpper > searchLower) {
        const sub = text.slice(searchLower, searchUpper + 1);

        // Prefer starting next chunk at sentence/paragraph boundary
        const sentenceStart = /(?:[.!?]\s+|\n\n|\n)(\S)/g;
        let sMatch: RegExpExecArray | null;
        while ((sMatch = sentenceStart.exec(sub)) !== null) {
          const matchPos = searchLower + sMatch.index + (sMatch[0].length - 1);
          if (matchPos > start && matchPos < end) {
            bestBoundary = matchPos;
          }
        }

        // Fallback to word boundary
        if (bestBoundary === -1) {
          const wordStart = /\s+(\S)/g;
          let wMatch: RegExpExecArray | null;
          while ((wMatch = wordStart.exec(sub)) !== null) {
            const matchPos = searchLower + wMatch.index + (wMatch[0].length - 1);
            if (matchPos > start && matchPos < end) {
              bestBoundary = matchPos;
            }
          }
        }
      }

      let nextStart = bestBoundary !== -1 ? bestBoundary : idealStart;
      while (nextStart < end && /\s/.test(text[nextStart]!)) {
        nextStart++;
      }

      if (nextStart <= start) nextStart = start + 1;
      if (nextStart >= end) nextStart = end;

      start = nextStart;
    }
  }

  return chunks;
}

/**
 * Convenient alias for chunkDocumentText.
 */
export const chunkDocument = chunkDocumentText;

/**
 * Chunks an existing attachment record without modifying the original extracted document.
 */
export const chunkAttachment = (
  attachment: Pick<IAttachment, "_id" | "extractedText"> | { _id?: unknown; id?: string; extractedText?: string | null | undefined },
  options?: ChunkingOptions,
): DocumentChunk[] => {
  const attachmentId = "id" in attachment && attachment.id
    ? attachment.id
    : attachment._id
      ? String(attachment._id)
      : "";

  const text = attachment.extractedText ?? "";
  return chunkDocumentText(attachmentId, text, options);
};
