import "dotenv/config";
import neo4j from "neo4j-driver";

async function main() {
  const uri = (process.env.NEO4J_URI || "").trim();
  const user = (process.env.NEO4J_USER || "").trim();
  const password = (process.env.NEO4J_PASSWORD || "").trim();
  console.log(
    JSON.stringify({
      type: "neo4j_probe_start",
      uri,
      user,
      password_set: Boolean(password),
    }),
  );
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    await driver.verifyConnectivity();
    const session = driver.session();
    try {
      const r = await session.run("RETURN 1 AS ok");
      console.log(
        JSON.stringify({
          type: "neo4j_probe_ok",
          ok: r.records[0]?.get("ok"),
        }),
      );
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      type: "neo4j_probe_fail",
      message: e instanceof Error ? e.message : String(e),
    }),
  );
  process.exit(1);
});
