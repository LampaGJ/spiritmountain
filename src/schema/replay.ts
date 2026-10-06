import { z } from 'zod';

/**
 * @displayName Replay record
 * @strategicPurpose Proves a generated file is reproducible from a pinned input; one shared base so every transform stamps the same shape.
 * @tacticalObjective Validates lowercase sha256 inputHash and outputHash, a 40-hex git SHA-1 codeCommit, and the declared effect. Transforms with extra members (for example a dropped list) call .extend() on this schema.
 */
export const ReplayRecordSchema = z.strictObject({
  // sha256 hex, lowercase (spec: raw inputs pinned with sha256; reproducible-data-manipulation.md:54 "all sha256 where hashed").
  inputHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, { error: 'inputHash must be 64 lowercase hex characters (sha256)' }),
  // Full git SHA-1 commit id, lowercase. A generator must refuse to stamp from a dirty tree; there is no dirty marker in this record.
  codeCommit: z.string().regex(/^[0-9a-f]{40}$/, {
    error: 'codeCommit must be 40 lowercase hex characters (git SHA-1)',
  }),
  outputHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, { error: 'outputHash must be 64 lowercase hex characters (sha256)' }),
  effect: z.enum(['preserves', 'reduces', 'expands']),
});
export type ReplayRecord = z.infer<typeof ReplayRecordSchema>;

/**
 * @displayName Generated-from record
 * @strategicPurpose The replay record a file embeds about its own generation; it omits outputHash because a file cannot contain its own hash.
 * @tacticalObjective Validates inputHash, codeCommit and effect only. The outputHash lives in the sidecar replay file, which uses the full ReplayRecordSchema.
 */
export const GeneratedFromSchema = ReplayRecordSchema.omit({ outputHash: true });
export type GeneratedFrom = z.infer<typeof GeneratedFromSchema>;
