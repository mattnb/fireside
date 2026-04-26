// server/src/agents/types.ts
export type AgentId = 'claude' | 'codex' | 'gemini' | 'echo';

export interface AgentSpec {
  id: AgentId;
  displayName: string;
  command: string; // e.g. 'claude'
  /** Builds CLI argv for one turn. Receives the prior session id (if any). */
  buildArgs(prompt: string, sessionId: string | null): string[];
  /** Optional pre-formatted text written to stdin. If undefined, the prompt
   *  goes via the CLI's argv (per the CLI's contract). */
  buildStdin?: (prompt: string, sessionId: string | null) => string;
  /** Parses the stdout (and optionally stderr) into a reply. */
  parseOutput(stdout: string, stderr: string): AgentReply;
  /** Default per-turn timeout in ms. */
  defaultTimeoutMs: number;
  /** Optional default working directory for this agent's subprocess.
   *  Used by runners when the caller does not pass an explicit `cwd`.
   *  The Gemini CLI auto-detects projects from cwd (presence of `docs/`,
   *  source files, etc.) and switches into agentic / tool-using mode that
   *  refuses to produce JSON. Setting `defaultCwd` to a neutral directory
   *  (e.g. the OS tmpdir) keeps gemini in pure-chat mode. Other agents
   *  inherit the broker's cwd by leaving this unset. */
  defaultCwd?: string;
}

export interface AgentReply {
  text: string;
  sessionId: string | null;
  raw: { stdout: string; stderr: string };
}

export class AgentParseError extends Error {
  constructor(
    public agentId: AgentId,
    message: string,
    public stdout: string,
    public stderr: string,
  ) {
    super(`[${agentId}] ${message}`);
    this.name = 'AgentParseError';
  }
}
