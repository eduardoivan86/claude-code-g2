// backend/src/native/types.ts
export type TurnRole = "user" | "assistant";

export interface Turn {
  uuid: string;
  sessionId: string;
  role: TurnRole;
  text: string;                 // concatenated text blocks
  thinking?: string;            // assistant thinking (optional for HUD)
  toolUses: { name: string; summary: string }[];
  isToolResult: boolean;        // user line that is a machine tool_result
  timestamp: string;
}

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  cwd: string;                  // real path recovered from file content
  project: string;              // basename(cwd)
  title: string;                // first human prompt, truncated
  updatedAt: number;            // mtime ms
}

export interface ProjectSummary {
  dirPath: string;
  cwd: string;                  // representative cwd
  project: string;
  sessionCount: number;
  updatedAt: number;            // latest mtime among sessions
}
