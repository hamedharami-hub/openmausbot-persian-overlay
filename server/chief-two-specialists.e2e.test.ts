import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("lets a Chief get independent results from two specialists and synthesize both", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: any[] }> = {};
  const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return response.json() as Promise<any>;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Fixture Chief", "--section", "Review")).bot;
    const researcher = (await cli("new-bot", "--name", "Fixture Researcher", "--section", "Review")).bot;
    const reviewer = (await cli("new-bot", "--name", "Fixture Reviewer", "--section", "Review")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });

    plans[researcher.id] = { turns: [{ reply: "RESEARCH_RESULT: three relevant sources agree on the timeline." }] };
    plans[reviewer.id] = { turns: [{ reply: "REVIEW_RESULT: the proposal misses one required dependency." }] };
    plans[chief.id] = { turns: [
      { steps: [
        { tool: "coordinate_bots", arguments: { bot_ids: [researcher.id], request_key: "independent-research", message: "Independently find the key evidence for the proposed timeline." } },
        { tool: "coordinate_bots", arguments: { bot_ids: [reviewer.id], request_key: "independent-review", message: "Independently review the proposal for a missing dependency." } },
      ], reply: "I assigned research and review separately." },
      { expectContextIncludes: ["RESEARCH_RESULT: three relevant sources agree on the timeline.", "REVIEW_RESULT: the proposal misses one required dependency."],
        reply: "SYNTHESIS: the timeline is supported, and the dependency must be added before approval." },
    ] };
    writeFileSync(planPath, JSON.stringify(plans));

    const sent = await fetch(`${url}/api/bots/${chief.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ text: "Have research and review check this proposal independently, then summarize their findings." }),
    });
    expect(sent.status).toBe(202);
    await expect.poll(() => providerTurns().filter(turn => turn.botId === chief.id).length, { timeout: 45_000 }).toBe(2);
    expect((await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "45")).status).toBe("settled");

    const turns = providerTurns();
    const researcherTurn = turns.find(turn => turn.botId === researcher.id);
    const reviewerTurn = turns.find(turn => turn.botId === reviewer.id);
    expect(researcherTurn).toBeTruthy();
    expect(reviewerTurn).toBeTruthy();
    expect(researcherTurn.threadId).not.toBe(reviewerTurn.threadId);
    expect(turns.filter(turn => turn.botId === chief.id)).toHaveLength(2);
    const chiefMessages = (await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=100`)).messages as any[];
    expect(chiefMessages.some(message => message.role === "bot" && message.kind === "text"
      && message.text?.includes("SYNTHESIS: the timeline is supported, and the dependency must be added before approval."))).toBe(true);
  } finally {
    await fixture.close();
  }
}, 90_000);
