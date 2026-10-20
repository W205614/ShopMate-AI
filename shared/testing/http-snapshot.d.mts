import type { Database, Session } from "../domain/types";
export function readHttpSnapshot(
  getJson: (path: string) => Promise<unknown>,
  role?: string,
): Promise<{
  db: Database;
  sessions: { user: Session | null; admin: Session | null };
}>;
