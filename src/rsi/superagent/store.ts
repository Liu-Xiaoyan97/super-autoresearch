/**
 * Superagent protocol — durable state.
 *
 * One run owns one store under `runs/<run_id>/superagent/`:
 *   state.json    triggers, threads, tickets, decisions, dispositions, policy
 *   events.jsonl  append-only domain events, in order
 *
 * Every mutation happens inside `atomic`, which persists the whole snapshot
 * once, so a crash never leaves half a decision behind (the prototype's
 * `Repositories.atomic` contract). `MemoryRepositories` is the same contract
 * without a filesystem, used by the CLI and by tests.
 */

import fs from "node:fs";
import path from "node:path";

import { canonical } from "../json.ts";
import type {
  Decision,
  DomainEvent,
  PolicySettings,
  Thread,
  Ticket,
  Trigger,
  TriggerDisposition,
} from "./model.ts";

export interface Snapshot {
  version: number;
  createdAt: string;
  updatedAt: string;
  policy: PolicySettings;
  triggers: Trigger[];
  threads: Thread[];
  tickets: Ticket[];
  decisions: Decision[];
  dispositions: Record<string, TriggerDisposition>;
}

export interface Repositories {
  /** Run `work` and persist its result as one unit. */
  atomic<T>(work: () => T): T;
  snapshot(): Snapshot;
  policy(): PolicySettings;
  savePolicy(policy: PolicySettings): void;
  triggers: {
    get(id: string): Trigger | undefined;
    save(trigger: Trigger): void;
    list(): Trigger[];
    disposition(id: string): TriggerDisposition | undefined;
    saveDisposition(id: string, value: TriggerDisposition): void;
  };
  threads: {
    get(key: string): Thread | undefined;
    save(thread: Thread): void;
    list(): Thread[];
  };
  tickets: {
    get(id: string): Ticket | undefined;
    save(ticket: Ticket): void;
    list(): Ticket[];
    open(): Ticket[];
  };
  decisions: {
    get(id: string): Decision | undefined;
    save(decision: Decision): void;
    list(): Decision[];
  };
  /** Append one domain event; file stores keep them in `events.jsonl`. */
  event(event: DomainEvent): void;
  events(): DomainEvent[];
  close(): void;
}

function emptySnapshot(policy: PolicySettings): Snapshot {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    policy,
    triggers: [],
    threads: [],
    tickets: [],
    decisions: [],
    dispositions: {},
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** In-memory repositories; `snapshot()` is a deep copy, as a file store would be. */
export class MemoryRepositories implements Repositories {
  private data: Snapshot;
  private log: DomainEvent[] = [];
  private depth = 0;

  constructor(policy: PolicySettings) {
    this.data = emptySnapshot(policy);
  }

  atomic<T>(work: () => T): T {
    this.depth += 1;
    try {
      const result = work();
      this.data.updatedAt = new Date().toISOString();
      return result;
    } finally {
      this.depth -= 1;
    }
  }

  snapshot(): Snapshot {
    return clone(this.data);
  }

  policy(): PolicySettings {
    return clone(this.data.policy);
  }

  savePolicy(policy: PolicySettings): void {
    this.data.policy = clone(policy);
  }

  triggers = {
    get: (id: string) => this.data.triggers.find((item) => item.id === id),
    save: (trigger: Trigger) => {
      const index = this.data.triggers.findIndex((item) => item.id === trigger.id);
      if (index < 0) this.data.triggers.push(trigger);
      else this.data.triggers[index] = trigger;
    },
    list: () => this.data.triggers.slice(),
    disposition: (id: string) => this.data.dispositions[id],
    saveDisposition: (id: string, value: TriggerDisposition) => {
      this.data.dispositions[id] = value;
    },
  };

  threads = {
    get: (key: string) => this.data.threads.find((item) => item.key === key),
    save: (thread: Thread) => {
      const index = this.data.threads.findIndex((item) => item.key === thread.key);
      if (index < 0) this.data.threads.push(thread);
      else this.data.threads[index] = thread;
    },
    list: () => this.data.threads.slice(),
  };

  tickets = {
    get: (id: string) => this.data.tickets.find((item) => item.id === id),
    save: (ticket: Ticket) => {
      const index = this.data.tickets.findIndex((item) => item.id === ticket.id);
      if (index < 0) this.data.tickets.push(ticket);
      else this.data.tickets[index] = ticket;
    },
    list: () => this.data.tickets.slice(),
    open: () => this.data.tickets.filter((item) => item.ended === undefined),
  };

  decisions = {
    get: (id: string) => this.data.decisions.find((item) => item.id === id),
    save: (decision: Decision) => {
      const index = this.data.decisions.findIndex((item) => item.id === decision.id);
      if (index < 0) this.data.decisions.push(decision);
      else this.data.decisions[index] = decision;
    },
    list: () => this.data.decisions.slice(),
  };

  event(event: DomainEvent): void {
    this.log.push(event);
  }

  events(): DomainEvent[] {
    return this.log.slice();
  }

  close(): void {
    /* nothing to flush */
  }
}

/** File-backed repositories: one snapshot file and one append-only event log. */
export class FileRepositories extends MemoryRepositories {
  readonly dir: string;
  readonly stateFile: string;
  readonly eventsFile: string;
  private loadedEvents: DomainEvent[] = [];

  constructor(dir: string, policy: PolicySettings) {
    const stateFile = path.join(dir, "state.json");
    const eventsFile = path.join(dir, "events.jsonl");
    let snapshot: Snapshot | null = null;
    let events: DomainEvent[] = [];
    if (fs.existsSync(stateFile)) {
      try {
        snapshot = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Snapshot;
      } catch {
        snapshot = null;
      }
    }
    if (fs.existsSync(eventsFile)) {
      events = fs
        .readFileSync(eventsFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as DomainEvent;
          } catch {
            return null;
          }
        })
        .filter((event): event is DomainEvent => event !== null);
    }
    super(snapshot?.policy ?? policy);
    this.dir = path.resolve(dir);
    this.stateFile = path.join(this.dir, "state.json");
    this.eventsFile = path.join(this.dir, "events.jsonl");
    fs.mkdirSync(this.dir, { recursive: true });
    if (snapshot) this.restore(snapshot);
    this.loadedEvents = events;
    if (!snapshot) this.flush();
  }

  private restore(snapshot: Snapshot): void {
    // MemoryRepositories has no import method; rebuilding through its public
    // surface keeps one code path for both stores.
    this.savePolicy(snapshot.policy);
    for (const trigger of snapshot.triggers) this.triggers.save(trigger);
    for (const thread of snapshot.threads) this.threads.save(thread);
    for (const ticket of snapshot.tickets) this.tickets.save(ticket);
    for (const decision of snapshot.decisions) this.decisions.save(decision);
    for (const [id, value] of Object.entries(snapshot.dispositions ?? {})) this.triggers.saveDisposition(id, value);
  }

  private flush(): void {
    const snapshot = canonical(this.snapshot()) as Snapshot;
    const temp = `${this.stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2), "utf8");
    fs.renameSync(temp, this.stateFile);
  }

  override atomic<T>(work: () => T): T {
    const result = super.atomic(work);
    this.flush();
    return result;
  }

  override event(event: DomainEvent): void {
    super.event(event);
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`, "utf8");
  }

  override events(): DomainEvent[] {
    return [...this.loadedEvents, ...super.events()];
  }
}

export function openRepositories(dir: string | null, policy: PolicySettings): Repositories {
  return dir ? new FileRepositories(dir, policy) : new MemoryRepositories(policy);
}
