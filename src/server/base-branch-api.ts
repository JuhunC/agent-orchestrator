import type { FastifyInstance } from "fastify";
import { loadBoards } from "../boards/loader.ts";
import { bus } from "../bus.ts";
import { repoAllowed } from "../config.ts";
import { listSchedules } from "../db.ts";
import { findInstallation, installationClient } from "../github/app.ts";
import { branchNameProblem, describeBaseSetting } from "../github/branches.ts";
import { errorMessage } from "../log.ts";
import { loadProfiles } from "../profiles/loader.ts";
import { checkBranchExists, chooseBase, repoBaseBranches, setRepoBaseBranch } from "../runtime/base-branch.ts";

/** Every base branch that's set, wherever it's set, for Settings → Base branches. */
function overview() {
  const profiles = loadProfiles();
  return {
    repos: Object.entries(repoBaseBranches())
      .map(([repo, branch]) => ({ repo, branch }))
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    boards: loadBoards(profiles)
      .boards.filter((board) => board.baseBranch)
      .map((board) => ({ name: board.name, branch: describeBaseSetting(board.baseBranch) })),
    agents: profiles.agents.filter((agent) => agent.github.baseBranch).map((agent) => ({ name: agent.name, branch: describeBaseSetting(agent.github.baseBranch) })),
    schedules: listSchedules()
      .filter((schedule) => schedule.baseBranch)
      .map((schedule) => ({ id: schedule.id, name: schedule.name, agent: schedule.agent, repo: `${schedule.owner}/${schedule.repo}`, branch: schedule.baseBranch })),
  };
}

export function registerBaseBranchRoutes(app: FastifyInstance): void {
  app.get("/api/base-branches", async () => overview());

  /** Sets (or with branch null, clears) one repository's base branch. */
  app.put<{ Body: { repo?: string; branch?: string | null } }>("/api/base-branches", async (request, reply) => {
    const repo = String(request.body?.repo ?? "").trim();
    const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repo);
    if (!match) return reply.code(400).send({ error: "Give the repository as owner/name" });
    const branch = request.body?.branch?.trim() || null;
    try {
      if (branch) {
        const problem = branchNameProblem(branch);
        if (problem) throw new Error(problem);
        if (!repoAllowed(repo)) throw new Error(`${repo} isn't in ALLOWED_REPOS`);
        let installationId: number;
        try {
          installationId = await findInstallation(match[1]!, match[2]!);
        } catch {
          throw new Error(`The GitHub App isn't installed on ${repo}`);
        }
        await checkBranchExists(await installationClient(installationId), match[1]!, match[2]!, branch);
      }
      setRepoBaseBranch(repo, branch);
      bus.publish({ type: "settings" });
      return overview();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  /** Which base branch an agent's work in a repository would use (outside boards), for the Run agent and schedule forms. */
  app.get<{ Querystring: { agent?: string; repo?: string } }>("/api/base-branches/resolve", async (request) => {
    const [owner = "", repo = ""] = String(request.query.repo ?? "").split("/");
    const profile = loadProfiles().agents.find((agent) => agent.name === request.query.agent) ?? null;
    return chooseBase({ owner, repo, profile });
  });
}
