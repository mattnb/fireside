// server/src/broker.ts
import { EventEmitter } from 'node:events';
import type { Database } from 'better-sqlite3';
import { addMessage, listMessages, type Message, type AuthorKind } from './repos/messages.js';
import { getRoom, deleteRoom as deleteRoomRepo } from './repos/rooms.js';
import { getCliSessionId, upsertCliSessionId } from './repos/sessions.js';
import { buildTurnPrompt } from './transcript.js';
import { parseMentions } from './mentions.js';
import type { AgentId, AgentReply, AgentSpec } from './agents/types.js';

export interface BrokerDeps {
  db: Database;
  runAgent: (spec: AgentSpec, prompt: string, sessionId: string | null) => Promise<AgentReply>;
  getSpec: (id: AgentId) => AgentSpec | undefined;
  maxHistory?: number;
}

export class Broker extends EventEmitter {
  constructor(private deps: BrokerDeps) {
    super();
  }

  async postHumanMessage(roomId: string, authorId: string, text: string): Promise<Message> {
    return this.append(roomId, authorId, 'human', text);
  }

  async postSystemMessage(roomId: string, text: string): Promise<Message> {
    return this.append(roomId, 'system', 'system', text);
  }

  deleteRoom(roomId: string): boolean {
    const ok = deleteRoomRepo(this.deps.db, roomId);
    if (ok) this.emit('roomDeleted', { roomId });
    return ok;
  }

  private async append(
    roomId: string,
    authorId: string,
    authorKind: AuthorKind,
    text: string,
  ): Promise<Message> {
    const room = getRoom(this.deps.db, roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);

    const message = this.appendDirect(roomId, authorId, authorKind, text);

    // Only inbound human/system messages can trigger agent replies. Agent messages do not.
    if (authorKind === 'agent') return message;

    const responders = this.pickResponders(room.agents, text, authorId);
    await Promise.all(
      responders.map((agentId) => this.runAgentReply(roomId, agentId, message)),
    );
    return message;
  }

  /**
   * Persist a message and emit `messageAppended` without dispatching agent replies.
   * Used for broker-internal system messages (failure notifications) where fanning
   * out would create a recursion loop.
   */
  private appendDirect(
    roomId: string,
    authorId: string,
    authorKind: AuthorKind,
    text: string,
  ): Message {
    const message = addMessage(this.deps.db, { roomId, authorId, authorKind, text });
    this.emit('messageAppended', message);
    return message;
  }

  private pickResponders(roomAgents: AgentId[], text: string, authorId: string): AgentId[] {
    const mentions = parseMentions(text);
    if (mentions.length > 0) {
      return mentions.filter((m) => roomAgents.includes(m));
    }
    return roomAgents.filter((a) => a !== authorId);
  }

  private async runAgentReply(roomId: string, agentId: AgentId, trigger: Message): Promise<void> {
    const spec = this.deps.getSpec(agentId);
    if (!spec) {
      this.appendDirect(roomId, 'system', 'system', `(no adapter for agent "${agentId}")`);
      return;
    }
    const room = getRoom(this.deps.db, roomId);
    if (!room) {
      // The room was created before this call ran; it should still exist. Defensive guard.
      throw new Error(`unknown room: ${roomId}`);
    }
    const allMessages = listMessages(this.deps.db, roomId);
    const history = allMessages.slice(0, -1); // exclude the trigger
    const prompt = buildTurnPrompt({
      agentId,
      roomName: room.name,
      history: history.map((m) => ({ authorId: m.authorId, authorKind: m.authorKind, text: m.text })),
      newMessage: { authorId: trigger.authorId, authorKind: trigger.authorKind, text: trigger.text },
      ...(this.deps.maxHistory !== undefined ? { maxHistory: this.deps.maxHistory } : {}),
    });
    const sessionId = getCliSessionId(this.deps.db, roomId, agentId);

    let reply: AgentReply;
    try {
      reply = await this.deps.runAgent(spec, prompt, sessionId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.appendDirect(roomId, 'system', 'system', `(${agentId} failed: ${errMsg})`);
      return;
    }

    if (reply.sessionId) {
      upsertCliSessionId(this.deps.db, roomId, agentId, reply.sessionId);
    }
    const text = reply.text.trim();
    if (text.length === 0) return; // agent declined to speak
    await this.append(roomId, agentId, 'agent', text);
  }
}
