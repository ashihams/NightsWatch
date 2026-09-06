import { createRequire } from "node:module";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env"), override: true });

async function main() {
  process.env.REPLAY_USE_OFFLINE = "1";
  process.env.MOCK_CRM_DETERMINISTIC = "1";
  process.env.TOOLS_KIND = "mock";
  process.env.REPLAY_DATA_ROOT = resolve(process.cwd(), "data/replay-demo-inline-test");

  const require = createRequire(resolve(process.cwd(), "package.json"));
  const { startMockCrmServer } = require("./tools/mock-server/index.js");
  const mock = await startMockCrmServer({ host: "127.0.0.1", port: 0 });
  process.env.TOOLS_BASE_URL = mock.baseUrl;

  const { runReplayDemo } = await import("./replay-demo.ts");
  const r = await runReplayDemo({
    forceOffline: true,
    onLog: (l) => {
      if (l.includes('"type"')) process.stdout.write(`${l.slice(0, 200)}\n`);
    },
  });
  console.log(
    JSON.stringify(
      {
        ok: r.ok,
        exit: r.exit_code,
        rows: r.rows.map((x) => ({
          label: x.label,
          success: x.success,
          first: x.first_tool,
          fail: x.failed_tool_calls,
          lessons: x.lessons_retrieved,
          promoted: x.lessons_promoted,
          path: x.retrieval_path,
        })),
      },
      null,
      2,
    ),
  );
  await mock.close();
  process.exit(r.exit_code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
