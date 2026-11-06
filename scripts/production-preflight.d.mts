export function validateProductionSettings(
  env: Record<string, string>,
): string[];
export function hostSecretPath(
  env: Record<string, string>,
  containerPath: string,
): string;
type RuntimeContainer = {
  Image: string;
  Config: { Labels?: Record<string, string>; Env: string[] };
  State: { Running: boolean; Health?: { Status: string } };
};
export function validateRunningRelease(
  env: Record<string, string>,
  images: Record<"api" | "web", { Id: string }>,
  containers: Record<"api" | "web", RuntimeContainer[]>,
): string[];
export function preflight(
  envFile: string,
  options?: { skipFiles?: boolean; skipDocker?: boolean; runtime?: boolean },
): {
  ok: boolean;
  problems: string[];
  checks: { files: boolean; imagesAndCompose: boolean; runtime: boolean };
  externalServicesTested: false;
};
