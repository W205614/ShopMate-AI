export const reviewedEdgeImage: string;
export const reviewedCaddyfileSha256: string;
interface EdgeService {
  image: string;
  environment: Record<string, string>;
  command?: string[];
  entrypoint?: string[] | null;
  volumes: {
    target: string;
    source: string;
    type: string;
    read_only?: boolean;
  }[];
}
export function validateEdgeInputs(
  edge: EdgeService,
  caddyfile: string | Uint8Array,
  configPath: string,
): { domain: string; email: string };
export function validateEdgeImage(image: {
  RepoDigests: string[];
  Architecture: string;
  Config: { Cmd?: string[]; Entrypoint?: string[] | null };
}): void;
export function validateAdaptedEdge(
  adapted: Record<string, unknown>,
  domain: string,
  email: string,
): { handlers: string[]; normalizedHash: string };
export function createEdgeVex(
  evidence: { normalizedHash: string },
  timestamp?: string,
): {
  statements: {
    vulnerability: { name: string };
    status: string;
    justification: string;
    products: {
      "@id": string;
      subcomponents: { "@id": string }[];
    }[];
  }[];
  [key: string]: unknown;
};
export function guardEdgeVex(options: {
  envFile?: string;
  output: string;
}): Record<string, unknown>;
